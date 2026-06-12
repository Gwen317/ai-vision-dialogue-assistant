import { Server, Socket } from 'socket.io';
import { ModelRouter } from '../model_router/ModelRouter';

interface Session {
  audioChunks: Buffer[];
  currentImageFrame: string | null;
  conversationHistory: any[];
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
        conversationHistory: [],
        abortController: null
      });

      // Handle incoming camera frame
      socket.on('image_frame', (base64Data: string) => {
        const session = this.sessions.get(socket.id);
        if (session) {
          session.currentImageFrame = base64Data;
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
      socket.on('vad_end', async () => {
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

          const imageFrame = session.currentImageFrame;

          // Call Gemini router
          await ModelRouter.processInteraction(
            socket,
            audioBuffer,
            imageFrame,
            session.conversationHistory,
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

          // 2. Truncate conversation history to match what the user actually heard
          if (session.conversationHistory.length > 0) {
            const lastMsg = session.conversationHistory[session.conversationHistory.length - 1];
            if (lastMsg.role === 'model' && typeof lastMsg.parts[0].text === 'string') {
              const originalText = lastMsg.parts[0].text;
              if (data.offset < originalText.length) {
                const truncatedText = originalText.substring(0, data.offset);
                console.log(`Truncating last message from "${originalText.substring(0, 30)}..." to "${truncatedText}"`);
                lastMsg.parts[0].text = truncatedText + "... [用户已打断]";
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
