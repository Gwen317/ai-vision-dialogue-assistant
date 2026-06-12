export class AudioAcousticProcessor {
  private audioCtx: AudioContext | null = null;
  private convolver: ConvolverNode | null = null;
  private gainNode: GainNode | null = null;
  private filterNode: BiquadFilterNode | null = null;
  private analyser: AnalyserNode | null = null;
  private noiseAnalyser: AnalyserNode | null = null;
  private backgroundNoiseLevel: number = 0;
  private micStreamNode: MediaStreamAudioSourceNode | null = null;

  constructor() {
    // Initialized on user gesture
  }

  public init() {
    if (this.audioCtx) return;
    
    this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    this.convolver = this.audioCtx.createConvolver();
    this.gainNode = this.audioCtx.createGain();
    this.filterNode = this.audioCtx.createBiquadFilter();
    this.analyser = this.audioCtx.createAnalyser();

    this.gainNode.gain.value = 1.0;
    this.filterNode.type = 'highshelf';
    this.filterNode.frequency.value = 3000;
    this.filterNode.gain.value = 0;

    // Route: Filter -> Convolver -> Gain -> Analyser -> Destination
    this.filterNode.connect(this.convolver);
    this.convolver.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);

    // Initial default synthetic reverb (living room)
    this.setReverbProperties(1.5, 2.0);
  }

  private generateImpulseResponse(duration: number, decay: number): AudioBuffer {
    if (!this.audioCtx) throw new Error('AudioContext not initialized');
    
    const sampleRate = this.audioCtx.sampleRate;
    const length = sampleRate * duration;
    const impulseBuffer = this.audioCtx.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulseBuffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const noise = Math.random() * 2 - 1;
        const envelope = Math.exp(-i / (sampleRate * (duration / decay)));
        channelData[i] = noise * envelope;
      }
    }
    return impulseBuffer;
  }

  public setReverbProperties(duration: number, decay: number) {
    if (!this.audioCtx || !this.convolver) return;
    
    if (duration <= 0.05) {
      // Bypassed (Studio Mode)
      this.filterNode?.disconnect();
      this.filterNode?.connect(this.gainNode!);
      console.log('Reverb bypassed (Studio Mode)');
    } else {
      this.filterNode?.disconnect();
      this.filterNode?.connect(this.convolver);
      const irBuffer = this.generateImpulseResponse(duration, decay);
      this.convolver.buffer = irBuffer;
      console.log(`Reverb updated: duration=${duration}s, decay=${decay}`);
    }
  }

  public startNoiseMonitoring(stream: MediaStream) {
    if (!this.audioCtx) return;

    this.noiseAnalyser = this.audioCtx.createAnalyser();
    this.noiseAnalyser.fftSize = 256;
    
    this.micStreamNode = this.audioCtx.createMediaStreamSource(stream);
    this.micStreamNode.connect(this.noiseAnalyser);

    const bufferLength = this.noiseAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const checkNoise = () => {
      if (!this.noiseAnalyser) return;
      
      this.noiseAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      
      this.backgroundNoiseLevel = average / 255.0;

      // Adapt Output Volume & Frequencies (Lombard Effect)
      if (this.gainNode && this.filterNode) {
        if (this.backgroundNoiseLevel > 0.15) {
          const extraVolume = 1.0 + (this.backgroundNoiseLevel - 0.15) * 1.5;
          this.gainNode.gain.value = Math.min(extraVolume, 2.5);

          const extraHighFreqBoost = (this.backgroundNoiseLevel - 0.15) * 12;
          this.filterNode.gain.value = Math.min(extraHighFreqBoost, 12);
        } else {
          this.gainNode.gain.value = 1.0;
          this.filterNode.gain.value = 0;
        }
      }

      requestAnimationFrame(checkNoise);
    };

    checkNoise();
  }

  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  public getAudioContext(): AudioContext | null {
    return this.audioCtx;
  }

  public getAudioGraphDestination(): AudioNode | null {
    return this.filterNode;
  }
}
