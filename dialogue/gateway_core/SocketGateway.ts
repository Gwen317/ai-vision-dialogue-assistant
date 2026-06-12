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

interface VADEndPayload {
  speechStartedAt?: number;
  speechEndedAt?: number;
}

interface Session {
  audioChunks: Buffer[];
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

          const cutoff = Date.now() - 60_000;
          session.timeline = session.timeline
            .filter(event => event.type !== 'image' || event.timestamp >= cutoff)
            .slice(-40);
        }
      });

      // Handle incoming streaming audio chunks
      socket.on('audio_chunk', (chunk: ArrayBuffer) => {
        const session = this.sessions.get(socket.id);
        if (session) {
          session.audioChunks.push(Buffer.from(chunk));
        }
      });

      // Handle VAD end (user finished speaking)
      socket.on('vad_end', async (payload?: VADEndPayload) => {
        const session = this.sessions.get(socket.id);
        if (!session) return;

        console.log(`VAD end detected for client ${socket.id}, processing request...`);
        socket.emit('state_change', 'THINKING');

        // Cancel any ongoing generation for this session
        if (session.abortController) {
          session.abortController.abort();
        }
        session.abortController = new AbortController();

        try {
          // Combine audio chunks into a single buffer
          const audioBuffer = Buffer.concat(session.audioChunks);
          session.audioChunks = []; // Clear for next turn

          const speechEndedAt = payload?.speechEndedAt ?? Date.now();
          const speechStartedAt = payload?.speechStartedAt ?? speechEndedAt;

          // Call Gemini router
          await ModelRouter.processInteraction(
            socket,
            audioBuffer,
            session.currentImageFrame,
            session.timeline,
            {
              speechStartedAt,
              speechEndedAt
            },
            session.abortController.signal
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
