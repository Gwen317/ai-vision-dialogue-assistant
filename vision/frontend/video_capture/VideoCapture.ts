export interface VideoFrame {
  timestamp: number;
  imageBase64: string;
}

export class VideoCapture {
  private mediaStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameQueue: VideoFrame[] = [];
  private readonly maxQueueSize = 10; // 5 seconds sliding window (assuming 2fps)
  private captureIntervalId: any = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.ctx = this.canvas.getContext('2d');
  }

  public async startCapture(stream: MediaStream) {
    this.mediaStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      console.warn('No video track found in the provided stream');
      return;
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    
    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play();
        resolve(true);
      };
    });

    // Start 500ms sliding window frame extraction
    this.captureIntervalId = setInterval(() => {
      if (!this.ctx || !this.canvas) return;

      this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      const dataUrl = this.canvas.toDataURL('image/jpeg', 0.7); // compress slightly
      const base64 = dataUrl.split(',')[1];

      const frame: VideoFrame = {
        timestamp: Date.now(),
        imageBase64: base64
      };

      this.frameQueue.push(frame);
      if (this.frameQueue.length > this.maxQueueSize) {
        this.frameQueue.shift(); // remove oldest frame
      }
    }, 500);

    console.log('Video sliding window buffer capture started.');
  }

  public stopCapture() {
    if (this.captureIntervalId) {
      clearInterval(this.captureIntervalId);
      this.captureIntervalId = null;
    }
    this.frameQueue = [];
    console.log('Video sliding window buffer capture stopped.');
  }

  public getAlignedFrames(speechStart: number, speechEnd: number): { startFrame: string | null; endFrame: string | null } {
    if (this.frameQueue.length === 0) return { startFrame: null, endFrame: null };

    // Find the frames closest to speech_start and speech_end
    let startFrame: VideoFrame | null = null;
    let endFrame: VideoFrame | null = null;

    let minStartDiff = Infinity;
    let minEndDiff = Infinity;

    for (const frame of this.frameQueue) {
      const startDiff = Math.abs(frame.timestamp - speechStart);
      if (startDiff < minStartDiff) {
        minStartDiff = startDiff;
        startFrame = frame;
      }

      const endDiff = Math.abs(frame.timestamp - speechEnd);
      if (endDiff < minEndDiff) {
        minEndDiff = endDiff;
        endFrame = frame;
      }
    }

    return {
      startFrame: startFrame ? startFrame.imageBase64 : null,
      endFrame: endFrame ? endFrame.imageBase64 : null
    };
  }
}
