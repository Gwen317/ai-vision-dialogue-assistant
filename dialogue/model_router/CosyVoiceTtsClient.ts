import WebSocket from 'ws';
import crypto from 'node:crypto';

export interface CosyVoiceTtsOptions {
  wsUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  sampleRate?: number;
  timeoutMs?: number;
}

export class CosyVoiceTtsClient {
  private wsUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private sampleRate: number;
  private timeoutMs: number;

  constructor(options: CosyVoiceTtsOptions = {}) {
    this.wsUrl = options.wsUrl || process.env.DASHSCOPE_WS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
    this.apiKey = options.apiKey || process.env.DASHSCOPE_API_KEY || '';
    this.defaultModel = options.defaultModel || 'cosyvoice-v3-flash';
    this.sampleRate = options.sampleRate || 24000;
    this.timeoutMs = options.timeoutMs || 30000; // 30 seconds default
  }

  public isConfigured(): boolean {
    return !!this.apiKey && this.apiKey !== 'mock' && !this.apiKey.startsWith('your_');
  }

  /**
   * Synthesizes text into speech buffer (MP3 by default).
   */
  public synthesize(
    text: string,
    voiceId: string,
    model?: string,
    speedRatio: number = 1.0
  ): Promise<Buffer> {
    if (!this.isConfigured()) {
      return Promise.reject(new Error('DashScope API Key is not configured for CosyVoice.'));
    }

    const taskId = crypto.randomUUID().replace(/-/g, '');
    const useModel = model || this.defaultModel;
    const auth = encodeURIComponent(`Bearer ${this.apiKey}`);
    
    // Trim trailing slash from URL
    const baseUrl = this.wsUrl.replace(/\/+$/, '');
    const wsUrl = `${baseUrl}?Authorization=${auth}`;

    return new Promise((resolve, reject) => {
      const audioChunks: Buffer[] = [];
      let resolved = false;

      const ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`
        }
      });

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.terminate();
          reject(new Error(`CosyVoice TTS timed out after ${this.timeoutMs}ms`));
        }
      }, this.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        resolved = true;
      };

      ws.on('open', () => {
        const runTaskMsg = {
          header: {
            action: 'run-task',
            task_id: taskId,
            streaming: 'duplex'
          },
          payload: {
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            model: useModel,
            parameters: {
              format: 'mp3',
              sample_rate: this.sampleRate,
              voice: voiceId,
              rate: speedRatio
            },
            input: {}
          }
        };
        ws.send(JSON.stringify(runTaskMsg));
      });

      ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
        if (isBinary) {
          audioChunks.push(data as Buffer);
        } else {
          try {
            const event = JSON.parse(data.toString());
            const eventName = event.header?.event;

            if (eventName === 'task-started') {
              // Send the text task
              const continueTaskMsg = {
                header: {
                  action: 'continue-task',
                  task_id: taskId,
                  streaming: 'duplex'
                },
                payload: {
                  input: {
                    text: text
                  }
                }
              };
              ws.send(JSON.stringify(continueTaskMsg));

              // Finish the task
              const finishTaskMsg = {
                header: {
                  action: 'finish-task',
                  task_id: taskId,
                  streaming: 'duplex'
                },
                payload: {
                  input: {}
                }
              };
              ws.send(JSON.stringify(finishTaskMsg));
            } else if (eventName === 'task-finished') {
              cleanup();
              ws.close();
              resolve(Buffer.concat(audioChunks));
            } else if (eventName === 'task-failed') {
              cleanup();
              ws.close();
              reject(new Error(`CosyVoice task failed: ${event.header?.error_message || JSON.stringify(event)}`));
            }
          } catch (e) {
            console.error('Failed to parse CosyVoice text event:', e);
          }
        }
      });

      ws.on('error', (err) => {
        if (!resolved) {
          cleanup();
          reject(new Error(`CosyVoice WebSocket error: ${err.message}`));
        }
      });

      ws.on('close', (code, reason) => {
        if (!resolved) {
          cleanup();
          reject(new Error(`CosyVoice WebSocket closed prematurely with code ${code}: ${reason.toString()}`));
        }
      });
    });
  }
}
