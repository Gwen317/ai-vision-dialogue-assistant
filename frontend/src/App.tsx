import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { FsmController } from '../../dialogue/vad_capture/FsmController';
import type { AppState } from '../../dialogue/vad_capture/FsmController';
import { AudioAcousticProcessor } from '../../dialogue/acoustic_reverb/AudioAcousticProcessor';
import { CanvasSyncRenderer } from '../../vision/drawing_sync/CanvasSyncRenderer';

export default function App() {
  const [appState, setAppState] = useState<AppState>('IDLE');
  const [transcription, setTranscription] = useState<string>('');
  const [aiResponse, setAiResponse] = useState<string>('');
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [reverbPreset, setReverbPreset] = useState<string>('studio'); // studio, living, hall
  const [noiseAdaptEnabled, setNoiseAdaptEnabled] = useState<boolean>(true);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);

  // HTML Media Elements Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Controller / Processor Instances Refs
  const socketRef = useRef<Socket | null>(null);
  const fsmRef = useRef<FsmController>(new FsmController());
  const acousticProcessorRef = useRef<AudioAcousticProcessor>(new AudioAcousticProcessor());
  const canvasRendererRef = useRef<CanvasSyncRenderer | null>(null);

  // Audio Recording & Playback Refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const visualizerIntervalRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Text & Streaming Playback Refs
  const speechQueueRef = useRef<string[]>([]);
  const isSpeakingRef = useRef<boolean>(false);
  const charOffsetRef = useRef<number>(0);
  const sentenceAccumulatorRef = useRef<string>('');
  const globalTextLengthRef = useRef<number>(0);

  useEffect(() => {
    // 1. Initialize WebSocket Connection
    const socket = io('http://localhost:3001');
    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketConnected(true);
      console.log('Connected to backend gateway');
    });

    socket.on('disconnect', () => {
      setSocketConnected(false);
      console.log('Disconnected from backend gateway');
    });

    // Handle state change from backend
    socket.on('state_change', (state: AppState) => {
      fsmRef.current.transitionTo(state);
    });

    // Handle user speech transcription
    socket.on('user_transcription', (text: string) => {
      setTranscription(text);
    });

    // Handle streaming text chunks from LLM
    socket.on('text_chunk', (chunk: string) => {
      setAiResponse(prev => {
        const newText = prev + chunk;
        globalTextLengthRef.current = newText.length;
        handleIncomingToken(chunk);
        return newText;
      });
    });

    // 2. FSM state change listener
    fsmRef.current.registerStateListener((state) => {
      setAppState(state);
      if (state === 'LISTENING') {
        // Stop any current text-to-speech playing
        window.speechSynthesis.cancel();
        speechQueueRef.current = [];
        isSpeakingRef.current = false;
        charOffsetRef.current = 0;
        sentenceAccumulatorRef.current = '';
        globalTextLengthRef.current = 0;
      }
    });

    // 3. Set up camera feed
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      })
      .catch((err) => console.error('Error opening camera:', err));

    // 4. Initialize Canvas Sync Renderer
    if (canvasRef.current) {
      canvasRendererRef.current = new CanvasSyncRenderer(canvasRef.current);
    }

    return () => {
      socket.disconnect();
      if (visualizerIntervalRef.current) clearInterval(visualizerIntervalRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, []);

  // Handle incoming tokens from LLM and assemble sentences for TTS
  const handleIncomingToken = (token: string) => {
    sentenceAccumulatorRef.current += token;
    
    // Check if the accumulated tokens end with a sentence delimiter
    const delimiters = ['。', '，', '！', '？', '；', '.', ',', '!', '?', '\n'];
    const text = sentenceAccumulatorRef.current;
    
    // Look for punctuation that signals a complete clause
    for (const delim of delimiters) {
      if (text.includes(delim)) {
        const parts = text.split(delim);
        // The first part is a complete clause
        const clause = parts[0] + delim;
        
        // Push the clause to the synthesis queue
        speechQueueRef.current.push(clause);
        
        // Retain the remaining incomplete text
        sentenceAccumulatorRef.current = parts.slice(1).join(delim);
        
        // Start playback if not already speaking
        if (!isSpeakingRef.current) {
          playNextSentence();
        }
        break;
      }
    }
  };

  const playNextSentence = () => {
    if (speechQueueRef.current.length === 0) {
      isSpeakingRef.current = false;
      return;
    }

    isSpeakingRef.current = true;
    const sentence = speechQueueRef.current.shift()!;
    const utterance = new SpeechSynthesisUtterance(sentence);
    
    // Get acoustic processor destination if Web Audio is active
    // Note: Standard speechSynthesis plays through default output, but we can hook it up if needed.
    
    // Track playback progress (character boundary events)
    utterance.onboundary = (event) => {
      if (event.name === 'word') {
        // Compute the overall global character offset
        const utteranceStartOffset = globalTextLengthRef.current - sentence.length;
        charOffsetRef.current = utteranceStartOffset + event.charIndex;
      }
    };

    utterance.onend = () => {
      playNextSentence();
    };

    utterance.onerror = () => {
      playNextSentence();
    };

    window.speechSynthesis.speak(utterance);
  };

  // Turn on/off Microphone, start local VAD (Fallback RMS Threshold VAD)
  const startRecordingSession = async () => {
    // Initialize Web Audio context
    acousticProcessorRef.current.init();
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Start environmental noise monitoring (Lombard Effect)
      if (noiseAdaptEnabled) {
        acousticProcessorRef.current.startNoiseMonitoring(stream);
      }

      // Initialize standard media recorder to stream audio chunks
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0 && socketRef.current) {
          const buffer = await e.data.arrayBuffer();
          socketRef.current.emit('audio_chunk', buffer);
        }
      };

      recorder.start(200); // chunk size: 200ms
      fsmRef.current.transitionTo('LISTENING');
      setTranscription('正在听您说话...');
      setAiResponse('');

      // Setup simple volume-threshold based VAD (Fallback VAD)
      const audioCtx = acousticProcessorRef.current.getAudioContext()!;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      let speaking = false;
      let silenceCounter = 0;

      const runVAD = () => {
        if (fsmRef.current.getCurrentState() === 'IDLE') return;

        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const rms = sum / bufferLength;

        // Threshold detection (RMS value > 15 means active speaking)
        if (rms > 15) {
          if (!speaking) {
            speaking = true;
            // If AI is playing, this is an interruption!
            if (isSpeakingRef.current) {
              console.log('Interruption detected!');
              window.speechSynthesis.cancel();
              socketRef.current?.emit('interrupt', { offset: charOffsetRef.current });
            }
          }
          silenceCounter = 0;
        } else {
          if (speaking) {
            silenceCounter++;
            // Require 1.2s of silence (60 frames at ~20ms each) to trigger end
            if (silenceCounter > 60) {
              speaking = false;
              silenceCounter = 0;
              triggerVADEnd();
            }
          }
        }
        
        requestAnimationFrame(runVAD);
      };

      runVAD();

      // Start 2fps Camera capture loop to sync with audio
      const captureFrame = () => {
        if (fsmRef.current.getCurrentState() === 'IDLE') return;

        const video = videoRef.current;
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');
        
        if (video && ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const base64Data = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
          socketRef.current?.emit('image_frame', base64Data);
        }
        
        setTimeout(captureFrame, 500); // 2fps
      };
      captureFrame();

      // Render audio visualizer on canvas
      renderVisualizer(analyser);

      // Auto-trigger the first interaction loop
      setTimeout(() => {
        if (socketRef.current) {
          console.log('Auto-initiating AI speech loop...');
          socketRef.current.emit('vad_end');
          fsmRef.current.transitionTo('THINKING');
        }
      }, 500);

    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  };

  const triggerVADEnd = () => {
    console.log('Silence detected, triggering VAD End');
    socketRef.current?.emit('vad_end');
    fsmRef.current.transitionTo('THINKING');
  };

  const renderVisualizer = (analyser: AnalyserNode) => {
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      if (fsmRef.current.getCurrentState() === 'IDLE') return;

      analyser.getByteFrequencyData(dataArray);
      ctx.fillStyle = 'rgba(10, 11, 16, 0.2)';
      ctx.fillRect(0, 0, 80, 20); // Small visualization block

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#00f2fe';
      ctx.beginPath();
      
      const sliceWidth = 80 / bufferLength;
      let x = 0;
      
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 255.0;
        const y = 20 - v * 20;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }
      ctx.stroke();
      animationFrameRef.current = requestAnimationFrame(draw);
    };
    draw();
  };

  const stopSession = () => {
    window.speechSynthesis.cancel();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    fsmRef.current.transitionTo('IDLE');
    setTranscription('');
    setAiResponse('');
  };

  const handleReverbChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const preset = e.target.value;
    setReverbPreset(preset);
    acousticProcessorRef.current.init();

    if (preset === 'studio') {
      acousticProcessorRef.current.setReverbProperties(0.01, 1.0);
    } else if (preset === 'living') {
      acousticProcessorRef.current.setReverbProperties(1.5, 2.0);
    } else if (preset === 'hall') {
      acousticProcessorRef.current.setReverbProperties(3.5, 4.0);
    }
  };

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '20px' }}>
      {!hasInteracted && (
        <div 
          onClick={async () => {
            setHasInteracted(true);
            await startRecordingSession();
          }}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            background: 'rgba(10, 11, 16, 0.95)',
            backdropFilter: 'blur(10px)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            cursor: 'pointer'
          }}
        >
          <div className="cyber-card" style={{ textAlign: 'center', padding: '40px', border: '1px solid #00f2fe', boxShadow: '0 0 30px rgba(0, 242, 254, 0.3)', width: '90%', maxWidth: '500px' }}>
            <h2 style={{ color: '#00f2fe', fontSize: '22px', marginBottom: '15px', fontFamily: 'Orbitron, sans-serif' }}>
              点击屏幕开启实时双工体验
            </h2>
            <p style={{ color: '#94a3b8', fontSize: '14px', lineHeight: '1.6' }}>
              系统将自动激活麦克风，AI 将持续循环朗读测试文本。<br />
              你只需随时说话即可瞬间中断 AI 播音，静音后 AI 会自动等待你开口，并在你停止说话后自动恢复朗读。
            </p>
            <div style={{ marginTop: '25px', display: 'inline-block', padding: '12px 24px', background: 'rgba(0, 242, 254, 0.1)', border: '1px solid #00f2fe', borderRadius: '4px', color: '#00f2fe', fontFamily: 'Orbitron', fontWeight: 'bold', letterSpacing: '1px' }}>
              CLICK TO START
            </div>
          </div>
        </div>
      )}

      {/* Top Banner */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 style={{ fontSize: '28px', color: '#00f2fe', textShadow: '0 0 10px rgba(0, 242, 254, 0.5)' }}>
            AI VISION DIALOGUE ASSISTANT
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '14px' }}>双工音视频协同 & 长程多模态情景记忆 V1.0</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span className={`led-dot led-${appState.toLowerCase()}`}></span>
          <span style={{ fontFamily: 'Orbitron', fontSize: '14px', textTransform: 'uppercase' }}>
            {appState}
          </span>
          <span style={{ fontSize: '12px', color: socketConnected ? '#10b981' : '#f43f5e', border: '1px solid currentColor', padding: '2px 8px', borderRadius: '4px' }}>
            {socketConnected ? 'GATEWAY ONLINE' : 'GATEWAY OFFLINE'}
          </span>
        </div>
      </header>

      {/* Main Grid */}
      <div className="blueprint-grid">
        {/* Left Side: Camera Preview & User Transcription */}
        <div className="cyber-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <h2 style={{ fontSize: '18px', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>
            CAMERA FEED & USER VOICE
          </h2>
          
          {/* Camera Frame Box */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-neon)' }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            <div style={{ position: 'absolute', bottom: '10px', left: '10px', display: 'flex', gap: '10px', alignItems: 'center' }}>
              <span className={`led-dot led-${appState === 'LISTENING' ? 'listening' : 'idle'}`}></span>
              <span style={{ fontSize: '12px', color: '#fff', textShadow: '1px 1px 2px #000' }}>
                {appState === 'LISTENING' ? 'MIC RECORDING' : 'MIC MUTE'}
              </span>
            </div>
          </div>

          {/* User Transcription Box */}
          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '15px', border: '1px solid rgba(255,255,255,0.05)', minHeight: '80px' }}>
            <span style={{ fontSize: '11px', color: '#00f2fe', fontFamily: 'Orbitron', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
              USER INPUT
            </span>
            <p style={{ fontSize: '15px', color: '#e2e8f0', lineHeight: '1.4' }}>
              {transcription || '点击下方按钮并对着麦克风说话...'}
            </p>
          </div>
        </div>

        {/* Right Side: Interactive Drawing Canvas & Controls */}
        <div className="cyber-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <h2 style={{ fontSize: '18px', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>
            INTERACTIVE SCHEMATIC CANVAS
          </h2>

          {/* Drawing Canvas Box */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#121420', borderRadius: '8px', border: '1px solid var(--border-neon-purple)' }}>
            <canvas ref={canvasRef} width={400} height={300} style={{ width: '100%', height: '100%', display: 'block' }} />
          </div>

          {/* Configuration Panel */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', padding: '10px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                Acoustic Reverb
              </label>
              <select 
                value={reverbPreset} 
                onChange={handleReverbChange}
                style={{ width: '100%', background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '8px', borderRadius: '4px', cursor: 'pointer' }}
              >
                <option value="studio">录音棚模式 (Studio)</option>
                <option value="living">客厅模式 (Living Room)</option>
                <option value="hall">教堂大厅模式 (Hall)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                Lombard Volume Adapt
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <input 
                  type="checkbox" 
                  checked={noiseAdaptEnabled} 
                  onChange={(e) => setNoiseAdaptEnabled(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                />
                <span style={{ fontSize: '13px', color: '#e2e8f0' }}>开启自适应噪音响度</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Segment: AI Response & Control Panel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '0 24px 24px' }}>
        {/* AI response box */}
        <div className="cyber-card" style={{ border: '1px solid var(--border-neon-purple)', boxShadow: '0 0 15px rgba(168, 85, 247, 0.15)' }}>
          <span style={{ fontSize: '11px', color: '#a855f7', fontFamily: 'Orbitron', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
            ASSISTANT RESPONSE
          </span>
          <p style={{ fontSize: '16px', color: '#e2e8f0', lineHeight: '1.6', minHeight: '40px' }}>
            {aiResponse || (appState === 'THINKING' ? 'AI 正在思考中，请稍候...' : '等待您的提问...')}
          </p>
        </div>

        {/* Central Controls */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px' }}>
          {appState === 'IDLE' ? (
            <button className="btn-neon" onClick={startRecordingSession}>
              <svg style={{ width: '18px', height: '18px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              开启语音通话 (Connect Mic)
            </button>
          ) : (
            <button className="btn-neon btn-neon-rose" onClick={stopSession}>
              <svg style={{ width: '18px', height: '18px' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 10a1 1 0 011-1h4a1 1 0 001-1m-1 5H9m0 0H7" />
              </svg>
              断开连接 (Mute Session)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
