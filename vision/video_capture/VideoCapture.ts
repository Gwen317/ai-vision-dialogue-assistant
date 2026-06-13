import '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { QualityGuard, type QualityResult } from '../quality_guard/QualityGuard';

export interface VideoFrame {
  timestamp: number;
  imageBase64: string;
  brightness: QualityResult;
  blur: QualityResult;
}

export class VideoCapture {
  private mediaStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameQueue: VideoFrame[] = [];
  private readonly maxQueueSize = 10; // 5 seconds sliding window (assuming 2fps)
  private captureIntervalId: any = null;

  // Object Detection variables
  private cocoModel: cocoSsd.ObjectDetection | null = null;
  private isLoadingModel = false;
  private onObjectDetectedCallback?: (className: string, base64Frame: string) => void = undefined;
  private onPredictionsDetectedCallback?: (predictions: cocoSsd.DetectedObject[]) => void = undefined;
  private cooldowns: Map<string, number> = new Map();
  private readonly cooldownMs = 15000; // 15 seconds cooldown per object class

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.ctx = this.canvas.getContext('2d');
  }

  public registerOnObjectDetected(callback: (className: string, base64Frame: string) => void) {
    this.onObjectDetectedCallback = callback;
  }

  public registerOnPredictionsDetected(callback: (predictions: cocoSsd.DetectedObject[]) => void) {
    this.onPredictionsDetectedCallback = callback;
  }

  public startCapture(video: HTMLVideoElement) {
    // Lazy-load the COCO-SSD object detection model in the background
    if (!this.cocoModel && !this.isLoadingModel) {
      this.isLoadingModel = true;
      console.log('[VideoCapture] Loading COCO-SSD object detection model...');
      cocoSsd.load()
        .then((model) => {
          this.cocoModel = model;
          this.isLoadingModel = false;
          console.log('[VideoCapture] COCO-SSD model loaded successfully.');
        })
        .catch((err) => {
          this.isLoadingModel = false;
          console.error('[VideoCapture] Failed to load COCO-SSD model:', err);
        });
    }

    // Start 500ms sliding window frame extraction
    this.captureIntervalId = setInterval(async () => {
      if (!this.ctx || !this.canvas) return;

      // Draw video to canvas with 'cover' behavior to match the screen display aspect ratio (aspectRatio: 4/3, objectFit: cover)
      const vWidth = video.videoWidth;
      const vHeight = video.videoHeight;
      if (vWidth && vHeight) {
        const canvasW = this.canvas.width;
        const canvasH = this.canvas.height;
        const rIn = vWidth / vHeight;
        const rOut = canvasW / canvasH;

        let drawW, drawH, dx, dy;
        if (rIn > rOut) {
          // Input is wider (e.g., 16:9): scale by height and crop left/right
          drawH = canvasH;
          drawW = canvasH * rIn;
          dx = (canvasW - drawW) / 2;
          dy = 0;
        } else {
          // Input is taller (e.g., 1:1): scale by width and crop top/bottom
          drawW = canvasW;
          drawH = canvasW / rIn;
          dx = 0;
          dy = (canvasH - drawH) / 2;
        }
        this.ctx.drawImage(video, dx, dy, drawW, drawH);
      } else {
        this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      }
      
      // Perform image quality check using QualityGuard
      const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
      const brightness = QualityGuard.checkBrightness(imageData);
      const blur = QualityGuard.checkBlur(imageData);

      const dataUrl = this.canvas.toDataURL('image/jpeg', 0.7); // compress slightly
      const base64 = dataUrl.split(',')[1];

      const frame: VideoFrame = {
        timestamp: Date.now(),
        imageBase64: base64,
        brightness,
        blur
      };

      this.frameQueue.push(frame);
      if (this.frameQueue.length > this.maxQueueSize) {
        this.frameQueue.shift(); // remove oldest frame
      }

      // If QualityGuard checks pass and model is loaded, run local object detection inference
      if (brightness.passed && blur.passed && this.cocoModel) {
        try {
          // Detect on the canvas to ensure coordinates align perfectly with 640x480 coordinate space
          const predictions = await this.cocoModel.detect(this.canvas);
          
          if (this.onPredictionsDetectedCallback) {
            this.onPredictionsDetectedCallback(predictions);
          }
          
          // Target typical everyday objects in the user's hand/feed
          const targetClasses = ['cell phone', 'cup', 'bottle', 'scissors', 'book', 'keyboard', 'mouse', 'laptop', 'handbag', 'banana', 'apple', 'orange'];
          
          const match = predictions.find(p => targetClasses.includes(p.class) && p.score > 0.65);
          if (match && this.onObjectDetectedCallback) {
            const className = match.class;
            const now = Date.now();
            const lastAlert = this.cooldowns.get(className) || 0;
            
            if (now - lastAlert > this.cooldownMs) {
              this.cooldowns.set(className, now);
              console.log(`[VideoCapture] Detected target: "${className}" with confidence ${(match.score * 100).toFixed(0)}%`);
              this.onObjectDetectedCallback(className, base64);
            }
          }
        } catch (err) {
          console.error('[VideoCapture] Object detection inference error:', err);
        }
      } else {
        // Clear bounding boxes if quality guard checks fail or model is not loaded
        if (this.onPredictionsDetectedCallback) {
          this.onPredictionsDetectedCallback([]);
        }
      }
    }, 500);

    console.log('Video sliding window buffer capture started with QualityGuard checks.');
  }

  public stopCapture() {
    if (this.captureIntervalId) {
      clearInterval(this.captureIntervalId);
      this.captureIntervalId = null;
    }
    this.frameQueue = [];
    console.log('Video sliding window buffer capture stopped.');
  }

  public getAlignedFrames(speechStart: number, speechEnd: number): { startFrame: VideoFrame | null; endFrame: VideoFrame | null } {
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
      startFrame,
      endFrame
    };
  }
}
