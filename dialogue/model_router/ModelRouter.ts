import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { Socket } from 'socket.io';
import { EpisodicMemoryService } from '../../memory_graph/episodic_memory/EpisodicMemoryService';

export class ModelRouter {
  private static genAI: GoogleGenerativeAI | null = null;

  private static getGenAI() {
    if (!this.genAI) {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    }
    return this.genAI;
  }

  public static async processInteraction(
    socket: Socket,
    audioBuffer: Buffer,
    imageFrame: string | null,
    history: any[],
    signal: AbortSignal
  ): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'mock' || apiKey.startsWith('your_')) {
      console.log('--- ModelRouter: Running in MOCK MODE ---');
      
      // Simulate transcription feedback
      socket.emit('user_transcription', '测试双工打断');
      
      // Notify state SPEAKING
      socket.emit('state_change', 'SPEAKING');
      
      const mockText = '这是一个用于测试双工流式打断功能的测试段落。在这个模式下，大模型不会进行真实的网络调用，而是以每两百毫秒一个词的速度向下游推送这一段很长的话。你可以随时对着你的麦克风说话，或者发出大一点的声音来测试端侧的静音检测是否能成功识别你开口说话的动作。一旦系统检测到你的声音，前端就会自动执行打断流程，将 AI 正在播放的声音静音，并通知后端强行关闭当前的流。我们可以测试后端的日志是否会打印 Stream generation aborted 和 Memory truncated。现在，请你试着说话来打断我吧！';
      
      const chunks = mockText.split(/(?=[，。、])| /);
      let fullResponseText = '';
      
      while (true) {
        for (const chunk of chunks) {
          if (signal.aborted) {
            console.log('Mock Stream generation aborted by client.');
            return;
          }
          
          fullResponseText += chunk;
          socket.emit('text_chunk', chunk);
          
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // Small delay between loops
        await new Promise((resolve) => setTimeout(resolve, 1000));
        console.log('Mock Stream looping: restarting text output.');
      }
      return;
    }

    const genAI = this.getGenAI();

    // 1. Transcribe the user's audio
    console.log('Transcribing user audio...');
    const flashModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    
    const transcriptionParts: Part[] = [
      {
        inlineData: {
          data: audioBuffer.toString('base64'),
          mimeType: 'audio/webm' // WebM default from media recorder
        }
      },
      {
        text: 'Please transcribe the speech in this audio exactly, without any extra text, corrections, or commentary. If there is no speech, output an empty string.'
      }
    ];

    const transcriptionResult = await flashModel.generateContent({
      contents: [{ role: 'user', parts: transcriptionParts }]
    });

    const userSpeech = transcriptionResult.response.text().trim();
    console.log(`Transcribed text: "${userSpeech}"`);

    if (!userSpeech) {
      console.log('No speech detected in audio.');
      socket.emit('user_transcription', '');
      socket.emit('state_change', 'IDLE');
      return;
    }

    // Emit the transcribed text back to the client immediately
    socket.emit('user_transcription', userSpeech);

    // 2. Query Long-Term Multimodal Episodic Memory
    console.log('Querying episodic memory...');
    const recalledMemory = await EpisodicMemoryService.queryMemory(userSpeech, imageFrame);
    
    // 3. Determine Model Routing (Tier 2 vs Tier 3)
    let selectedModelName = 'gemini-2.5-flash'; // Tier 2 (Default)
    const complexKeywords = ['debug', 'code', 'math', 'solve', 'circuit', 'program', 'algorithm', 'explain in detail', 'analyze'];
    const lowerSpeech = userSpeech.toLowerCase();
    
    if (complexKeywords.some(keyword => lowerSpeech.includes(keyword))) {
      selectedModelName = 'gemini-1.5-pro'; // Route to Tier 3 (Pro)
      console.log(`Routing query to Tier 3 Model: ${selectedModelName}`);
    } else {
      console.log(`Routing query to Tier 2 Model: ${selectedModelName}`);
    }

    const model = genAI.getGenerativeModel({ model: selectedModelName });

    // 4. Construct System Instruction / Prompt with memory context
    let systemInstruction = 'You are a futuristic, helpful AI Vision Dialogue Assistant. You have access to the user\'s real-time camera feed and microphone. Answer clearly, naturally, and concisely.';
    
    if (recalledMemory) {
      const timeDiff = Math.round((Date.now() - recalledMemory.timestamp.getTime()) / 60000); // Minutes
      systemInstruction += `\n[RECALLED EPISODIC MEMORY] You have recalled a past event from ${timeDiff} minutes ago. The user previously showed a/an "${recalledMemory.description}" and the conversation was:\n${recalledMemory.transcript}\nRefer to this past event naturally if the user asks about the past, mentions things shown earlier, or asks you to compare items.`;
    }

    // 5. Assemble current payload parts
    const currentParts: Part[] = [];
    
    // Inject the latest image frame if available
    if (imageFrame) {
      currentParts.push({
        inlineData: {
          data: imageFrame,
          mimeType: 'image/jpeg'
        }
      });
    }

    // Inject the transcription of user speech
    currentParts.push({ text: userSpeech });

    // Prepare full conversation contents structure
    const contents: any[] = [];

    // Add history (limiting to last 6 messages to keep context window light and fast)
    const recentHistory = history.slice(-6);
    for (const msg of recentHistory) {
      contents.push({
        role: msg.role,
        parts: msg.parts
      });
    }

    // Add current user input parts
    contents.push({
      role: 'user',
      parts: currentParts
    });

    // 6. Generate content stream
    console.log('Generating streaming content...');
    socket.emit('state_change', 'SPEAKING');
    
    const responseStream = await model.generateContentStream({
      contents,
      generationConfig: {
        systemInstruction
      }
    });

    let fullResponseText = '';

    for await (const chunk of responseStream.stream) {
      // Check for abort signal from client interruption
      if (signal.aborted) {
        console.log('Stream generation aborted.');
        return;
      }
      
      const chunkText = chunk.text();
      fullResponseText += chunkText;
      
      // Stream text chunk to client
      socket.emit('text_chunk', chunkText);
    }

    console.log('Stream generation completed.');

    // Save this turn to conversation history
    history.push({
      role: 'user',
      parts: [{ text: userSpeech }]
    });
    history.push({
      role: 'model',
      parts: [{ text: fullResponseText }]
    });

    // 7. Save to Long-Term Episodic Memory in the background (non-blocking)
    EpisodicMemoryService.recordMemory(userSpeech, fullResponseText, imageFrame)
      .catch(err => console.error('Background memory recording failed:', err));

    socket.emit('state_change', 'IDLE');
  }
}
