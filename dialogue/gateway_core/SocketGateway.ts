import { Server, Socket } from 'socket.io';
import { ModelRouter } from '../model_router/ModelRouter';

interface ImageFrameEvent {
  type: 'image';
  timestamp: number;
  imageBase64: string;
}

interface ConversationMessageEvent {
  type: 'message';
  timestamp: number;
  role: 'user' | 'model';
  parts: any[];
}

export type TimelineEvent = ImageFrameEvent | ConversationMessageEvent;

interface ImageFramePayload {
  imageBase64: string;
  timestamp?: number;
}

interface AudioChunkPayload {
  data?: ArrayBuffer | Buffer | { type?: string; data?: number[] };
  mimeType?: string;
}

interface VADEndPayload {
  speechStartedAt?: number;
  speechEndedAt?: number;
  localText?: string;
  llmProvider?: string;
  ttsProvider?: string;
  startFrame?: string;
  endFrame?: string;
}

interface VADStartPayload {
  speechStartedAt?: number;
}

interface TextQueryPayload {
  text: string;
  speechStartedAt?: number;
  speechEndedAt?: number;
  llmProvider?: string;
  ttsProvider?: string;
}

interface Session {
  audioChunks: Buffer[];
  audioMimeType: string;
  isCapturingSpeech: boolean;
  currentImageFrame: ImageFrameEvent | null;
  timeline: TimelineEvent[];
  abortController: AbortController | null;
}

export class SocketGateway {
  private io: Server;
  private sessions: Map<string, Session> = new Map();

  constructor(io: Server) {
    this.io = io;
  }

  public init() {
    this.io.on('connection', (socket: Socket) => {
      console.log(`Client connected: ${socket.id}`);
      
      // Initialize session for this client
      this.sessions.set(socket.id, {
        audioChunks: [],
        audioMimeType: 'audio/webm',
        isCapturingSpeech: false,
        currentImageFrame: null,
        timeline: [],
        abortController: null
      });

      // Handle incoming camera frame
      socket.on('image_frame', (payload: string | ImageFramePayload) => {
        const session = this.sessions.get(socket.id);
        if (session) {
          const imageBase64 = typeof payload === 'string' ? payload : payload.imageBase64;
          const timestamp = typeof payload === 'string' ? Date.now() : payload.timestamp ?? Date.now();
          const imageEvent: ImageFrameEvent = {
            type: 'image',
            timestamp,
            imageBase64
          };

          session.currentImageFrame = imageEvent;
          session.timeline.push(imageEvent);
          console.log(`Image frame received for ${socket.id} at ${new Date(timestamp).toISOString()}`);

          const cutoff = Date.now() - 60_000;
          session.timeline = session.timeline
            .filter(event => event.type !== 'image' || event.timestamp >= cutoff)
            .slice(-40);
        }
      });

      // Handle incoming streaming audio chunks
      socket.on('audio_chunk', (payload: ArrayBuffer | AudioChunkPayload) => {
        const session = this.sessions.get(socket.id);
        if (session?.isCapturingSpeech) {
          const rawChunk = payload instanceof ArrayBuffer ? payload : payload.data;
          if (!rawChunk) {
            console.error(`Ignoring audio_chunk for ${socket.id}: missing payload data`);
            return;
          }

          const chunkBuffer = Buffer.isBuffer(rawChunk)
            ? rawChunk
            : rawChunk instanceof ArrayBuffer
              ? Buffer.from(rawChunk)
              : Array.isArray(rawChunk.data)
                ? Buffer.from(rawChunk.data)
                : null;

          if (!chunkBuffer) {
            console.error(`Ignoring audio_chunk for ${socket.id}: unsupported payload shape`);
            return;
          }

          session.audioMimeType = payload instanceof ArrayBuffer ? session.audioMimeType : payload.mimeType || session.audioMimeType;
          session.audioChunks.push(chunkBuffer);
          if (session.audioChunks.length === 1 || session.audioChunks.length % 25 === 0) {
            console.log(`Audio chunks buffered for ${socket.id}: chunks=${session.audioChunks.length}, lastChunkBytes=${chunkBuffer.byteLength}`);
          }
        }
      });

      socket.on('vad_start', (payload?: VADStartPayload) => {
        const session = this.sessions.get(socket.id);
        if (!session) return;

        session.audioChunks = [];
        session.audioMimeType = 'audio/webm';
        session.isCapturingSpeech = true;
        const speechStartedAt = payload?.speechStartedAt ?? Date.now();
        console.log(`VAD start for ${socket.id}: cleared audio buffer at ${new Date(speechStartedAt).toISOString()}`);
      });

      socket.on('text_query', async (payload: TextQueryPayload) => {
        const session = this.sessions.get(socket.id);
        if (!session) return;

        const text = payload.text?.trim();
        if (!text) return;

        console.log(`Text query received for ${socket.id}: "${text}"`);
        socket.emit('state_change', 'THINKING');

        if (session.abortController) {
          session.abortController.abort();
        }
        session.abortController = new AbortController();

        try {
          const speechEndedAt = payload.speechEndedAt ?? Date.now();
          const speechStartedAt = payload.speechStartedAt ?? speechEndedAt;
          session.audioChunks = [];

          await ModelRouter.processTextInteraction(
            socket,
            text,
            session.currentImageFrame,
            session.timeline,
            {
              speechStartedAt,
              speechEndedAt
            },
            session.abortController.signal,
            payload.llmProvider,
            payload.ttsProvider
          );
        } catch (err) {
          console.error('Error processing text query:', err);
          socket.emit('error', 'Error generating response. Please try again.');
          socket.emit('state_change', 'IDLE');
        } finally {
          session.abortController = null;
        }
      });

      // Handle VAD end (user finished speaking)
      socket.on('vad_end', async (payload?: VADEndPayload) => {
        const session = this.sessions.get(socket.id);
        if (!session) return;

        const localText = payload?.localText || '';
        console.log(`VAD end detected for client ${socket.id}, local ASR text: "${localText}", processing request...`);
        socket.emit('state_change', 'THINKING');

        // Cancel any ongoing generation for this session
        if (session.abortController) {
          session.abortController.abort();
        }
        session.abortController = new AbortController();

        try {
          // Combine audio chunks into a single buffer
          const audioBuffer = Buffer.concat(session.audioChunks);
          const audioMimeType = session.audioMimeType;
          session.audioChunks = []; // Clear for next turn
          session.isCapturingSpeech = false;

          const speechEndedAt = payload?.speechEndedAt ?? Date.now();
          const speechStartedAt = payload?.speechStartedAt ?? speechEndedAt;
          console.log(
            `VAD payload for ${socket.id}: audioBytes=${audioBuffer.byteLength}, audioMimeType=${audioMimeType}, speechStartedAt=${new Date(speechStartedAt).toISOString()}, speechEndedAt=${new Date(speechEndedAt).toISOString()}`
          );

          // Inject aligned start and end frames to the session's timeline
          if (payload?.startFrame) {
            session.timeline.push({
              type: 'image',
              timestamp: speechStartedAt,
              imageBase64: payload.startFrame
            });
            console.log(`Pushed start frame to session timeline at ${new Date(speechStartedAt).toISOString()}`);
          }
          if (payload?.endFrame) {
            const endImageEvent: ImageFrameEvent = {
              type: 'image',
              timestamp: speechEndedAt,
              imageBase64: payload.endFrame
            };
            session.currentImageFrame = endImageEvent;
            session.timeline.push(endImageEvent);
            console.log(`Pushed end frame to session timeline at ${new Date(speechEndedAt).toISOString()}`);
          }

          // Call Gemini router
          await ModelRouter.processInteraction(
            socket,
            audioBuffer,
            audioMimeType,
            session.currentImageFrame,
            session.timeline,
            {
              speechStartedAt,
              speechEndedAt
            },
            session.abortController.signal,
            localText,
            payload?.llmProvider,
            payload?.ttsProvider
          );
        } catch (err: any) {
          if (err.name === 'AbortError') {
            console.log(`Generation aborted for client ${socket.id}`);
          } else {
            console.error(`Error processing VAD end:`, err);
            socket.emit('error', 'Error generating response. Please try again.');
            socket.emit('state_change', 'IDLE');
          }
        } finally {
          session.abortController = null;
        }
      });

      // Handle user interruption
      socket.on('interrupt', (data: { offset: number }) => {
        const session = this.sessions.get(socket.id);
        if (session) {
          console.log(`Interrupt received from client ${socket.id} at offset ${data.offset}`);
          
          // 1. Cancel ongoing LLM request
          if (session.abortController) {
            session.abortController.abort();
            session.abortController = null;
          }

          // 2. Truncate conversation timeline to match what the user actually heard
          if (session.timeline.length > 0) {
            const lastMsg = [...session.timeline]
              .reverse()
              .find((event): event is ConversationMessageEvent => event.type === 'message' && event.role === 'model');

            if (lastMsg && typeof lastMsg.parts[0].text === 'string') {
              const originalText = lastMsg.parts[0].text;
              if (data.offset < originalText.length) {
                const truncatedText = originalText.substring(0, data.offset);
                console.log(`Truncating last message from "${originalText.substring(0, 30)}..." to "${truncatedText}"`);
                lastMsg.parts[0].text = truncatedText + "... [user interrupted]";
              }
            }
          }

          socket.emit('state_change', 'LISTENING');
        }
      });

      // Handle clear history
      socket.on('clear_history', () => {
        const session = this.sessions.get(socket.id);
        if (session) {
          console.log(`Clearing history and state for client ${socket.id}`);
          session.timeline = [];
          session.audioChunks = [];
          if (session.abortController) {
            session.abortController.abort();
            session.abortController = null;
          }
        }
      });

      // Ping-pong for keep-alive
      socket.on('ping', () => {
        socket.emit('pong');
      });

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        const session = this.sessions.get(socket.id);
        if (session?.abortController) {
          session.abortController.abort();
        }
        this.sessions.delete(socket.id);
      });
    });
  }
}
