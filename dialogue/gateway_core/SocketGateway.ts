import { Server, Socket } from 'socket.io';
import { ModelRouter } from '../model_router/ModelRouter';

export class SocketGateway {
  private io: Server;
  private conversationHistoryMap: Map<string, any[]> = new Map();
  private abortControllerMap: Map<string, AbortController> = new Map();

  constructor(io: Server) {
    this.io = io;
  }

  public init() {
    this.io.on('connection', (socket: Socket) => {
      console.log(`Client connected: ${socket.id}`);
      this.conversationHistoryMap.set(socket.id, []);

      // Receive audio binary streams
      socket.on('audio_chunk', (chunk: Buffer) => {
        // Handle incoming raw audio chunks and append to buffer if needed
      });

      // Receive VAD end and trigger model processing
      socket.on('vad_end', async (data: { audio: Buffer; image: string | null }) => {
        const history = this.conversationHistoryMap.get(socket.id) || [];
        
        // Setup AbortController for potential interruptions
        const abortController = new AbortController();
        this.abortControllerMap.set(socket.id, abortController);

        try {
          socket.emit('state_change', 'THINKING');
          await ModelRouter.processInteraction(
            socket,
            data.audio,
            data.image,
            history,
            abortController.signal
          );
        } catch (err) {
          console.error('Error processing interaction:', err);
          socket.emit('state_change', 'IDLE');
        } finally {
          this.abortControllerMap.delete(socket.id);
        }
      });

      // Handle user interruption
      socket.on('interrupt', (data: { offset: number }) => {
        console.log(`User interrupt received for socket ${socket.id}, offset: ${data.offset}`);
        
        // 1. Abort ongoing Gemini stream
        const abortController = this.abortControllerMap.get(socket.id);
        if (abortController) {
          abortController.abort();
          this.abortControllerMap.delete(socket.id);
        }

        // 2. Perform Memory Truncation (prevent memory split)
        const history = this.conversationHistoryMap.get(socket.id);
        if (history && history.length > 0) {
          const lastMsg = history[history.length - 1];
          if (lastMsg && lastMsg.role === 'model' && lastMsg.parts[0]?.text) {
            const originalText = lastMsg.parts[0].text;
            // Truncate response up to estimated characters sent before interrupt
            const truncatedText = originalText.substring(0, data.offset) + '... [Interrupted by user]';
            lastMsg.parts[0].text = truncatedText;
            console.log(`Memory truncated to: "${truncatedText}"`);
          }
        }

        socket.emit('state_change', 'LISTENING');
      });

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        this.conversationHistoryMap.delete(socket.id);
        this.abortControllerMap.delete(socket.id);
      });
    });
  }
}
