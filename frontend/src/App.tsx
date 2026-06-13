import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { FsmController } from '../../dialogue/vad_capture/FsmController';
import type { AppState } from '../../dialogue/vad_capture/FsmController';
import { AudioAcousticProcessor } from '../../dialogue/acoustic_reverb/AudioAcousticProcessor';
import { CanvasSyncRenderer } from '../../vision/drawing_sync/CanvasSyncRenderer';
import { MicVAD } from '@ricky0123/vad-web';
import { VideoCapture } from '../../vision/video_capture/VideoCapture';
import { D3GraphRenderer, type GraphNode, type GraphLink } from '../../memory_graph/entity_graph/D3GraphRenderer';

function selectSpeechMimeType(): string {
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm'
  ];

  return candidates.find(candidate => MediaRecorder.isTypeSupported(candidate)) || '';
}

interface TimelineMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: string;
  isStreaming?: boolean;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('IDLE');
  const [transcription, setTranscription] = useState<string>('');
  const [aiResponse, setAiResponse] = useState<string>('');
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [reverbPreset, setReverbPreset] = useState<string>('studio'); // studio, living, hall
  const [noiseAdaptEnabled, setNoiseAdaptEnabled] = useState<boolean>(true);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState<boolean>(false);
  const [timeline, setTimeline] = useState<TimelineMessage[]>([]);
  const [detectedObjects, setDetectedObjects] = useState<any[]>([]);

  // ─── 记忆图谱状态 ───
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const [graphLinks, setGraphLinks] = useState<GraphLink[]>([]);
  const [showGraph, setShowGraph] = useState<boolean>(false);
  const [selectedGraphNode, setSelectedGraphNode] = useState<GraphNode | null>(null);
  const graphNodeSetRef = useRef<Set<string>>(new Set());

  // HTML Media Elements Refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Controller / Processor Instances Refs
  const socketRef = useRef<Socket | null>(null);
  const fsmRef = useRef<FsmController>(new FsmController());
  const acousticProcessorRef = useRef<AudioAcousticProcessor>(new AudioAcousticProcessor());
  const canvasRendererRef = useRef<CanvasSyncRenderer | null>(null);
  const videoCaptureRef = useRef<VideoCapture>(new VideoCapture());

  // Audio Recording & Playback Refs
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const visualizerIntervalRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const vadRef = useRef<any>(null);
  const currentSpeechStartedAtRef = useRef<number | null>(null);
  const isRecordingSpeechRef = useRef<boolean>(false);
  const speechChunksRef = useRef<Blob[]>([]);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const localSpeechTextRef = useRef<string>('');
  const tempUserMsgIdRef = useRef<string | null>(null);
  const isSpeechRecognitionActiveRef = useRef<boolean>(false);

  // Text & Streaming Playback Refs
  const speechQueueRef = useRef<string[]>([]);
  const isSpeakingRef = useRef<boolean>(false);
  const charOffsetRef = useRef<number>(0);
  const sentenceAccumulatorRef = useRef<string>('');
  const globalTextLengthRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<{ index: number; audio: ArrayBuffer }[]>([]);
  const nextPlayIndexRef = useRef<number>(0);
  const isAudioPlayingRef = useRef<boolean>(false);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const isCosyVoiceActiveRef = useRef<boolean>(false);
  const [interruptThreshold, setInterruptThreshold] = useState<number>(0.85);
  const interruptThresholdRef = useRef<number>(0.85);
  const speechProbabilityRef = useRef<number>(0);
  const [llmProvider, setLlmProvider] = useState<string>(() => localStorage.getItem('llm_provider') || 'dashscope');
  const llmProviderRef = useRef<string>(localStorage.getItem('llm_provider') || 'dashscope');
  const [ttsProvider, setTtsProvider] = useState<string>(() => localStorage.getItem('tts_provider') || 'cosyvoice');
  const ttsProviderRef = useRef<string>(localStorage.getItem('tts_provider') || 'cosyvoice');

  const resetAssistantStreamState = () => {
    setAiResponse('');
    speechQueueRef.current = [];
    sentenceAccumulatorRef.current = '';
    globalTextLengthRef.current = 0;
    charOffsetRef.current = 0;
    audioQueueRef.current = [];
    nextPlayIndexRef.current = 0;
    isAudioPlayingRef.current = false;
    isCosyVoiceActiveRef.current = false;
  };

  useEffect(() => {
    interruptThresholdRef.current = interruptThreshold;
  }, [interruptThreshold]);

  useEffect(() => {
    llmProviderRef.current = llmProvider;
    localStorage.setItem('llm_provider', llmProvider);
  }, [llmProvider]);

  useEffect(() => {
    ttsProviderRef.current = ttsProvider;
    localStorage.setItem('tts_provider', ttsProvider);

    // Clean up all playing speech when switching TTS engines
    window.speechSynthesis.cancel();
    speechQueueRef.current = [];
    isSpeakingRef.current = false;
    
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) {}
      audioSourceRef.current = null;
    }
    audioQueueRef.current = [];
    nextPlayIndexRef.current = 0;
    isAudioPlayingRef.current = false;
  }, [ttsProvider]);

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

    socket.on('audio_tts_chunk', (chunk: { audio: ArrayBuffer; index: number }) => {
      if (ttsProviderRef.current !== 'cosyvoice') {
        return; // Ignore backend audio chunks if cosyvoice is disabled
      }
      console.log(`Received audio TTS chunk index ${chunk.index}, bytes=${chunk.audio.byteLength}`);
      isCosyVoiceActiveRef.current = true;
      audioQueueRef.current.push({ index: chunk.index, audio: chunk.audio });
      audioQueueRef.current.sort((a, b) => a.index - b.index);
      if (!isAudioPlayingRef.current) {
        playNextAudioChunk();
      }
    });

    // Handle state change from backend
    socket.on('state_change', (state: AppState) => {
      fsmRef.current.transitionTo(state);
      if (state === 'IDLE' || state === 'LISTENING') {
        setTimeline(prev => {
          const next = [...prev];
          const lastMsgIndex = next.map(m => m.role).lastIndexOf('model');
          if (lastMsgIndex !== -1 && next[lastMsgIndex].isStreaming) {
            next[lastMsgIndex] = {
              ...next[lastMsgIndex],
              isStreaming: false
            };
          }
          return next;
        });

        // Restart local ASR when returning to LISTENING (AI finished speaking)
        if (state === 'LISTENING' && recognitionRef.current && !isSpeechRecognitionActiveRef.current) {
          try {
            recognitionRef.current.start();
          } catch (e) {
            console.log('Ignore start delay error on state change:', e);
          }
        }
      }
    });

    // Handle user speech transcription
    socket.on('user_transcription', (text: string) => {
      setTranscription(text);
      const cleanText = text.trim();
      if (cleanText) {
        resetAssistantStreamState();
        setTimeline(prev => {
          const next = [...prev];
          const lastModelIndex = next.map(m => m.role).lastIndexOf('model');
          if (lastModelIndex !== -1 && next[lastModelIndex].isStreaming) {
            next[lastModelIndex] = {
              ...next[lastModelIndex],
              isStreaming: false
            };
          }
          const tempIndex = next.findIndex(m => m.id === tempUserMsgIdRef.current);
          if (tempIndex !== -1) {
            // Replace the temporary message with the final backend-transcribed text
            next[tempIndex] = {
              ...next[tempIndex],
              id: 'user-' + Date.now(),
              text: cleanText
            };
          } else {
            // Append if no temp message was found
            next.push({
              id: 'user-' + Date.now(),
              role: 'user',
              text: cleanText,
              timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            });
          }
          return next;
        });
      } else {
        // If final text is empty, remove the temp message from the timeline to avoid empty bubbles
        if (tempUserMsgIdRef.current) {
          setTimeline(prev => prev.filter(m => m.id !== tempUserMsgIdRef.current));
        }
      }
      // Reset variables for the next turn
      tempUserMsgIdRef.current = null;
      localSpeechTextRef.current = '';
    });

    // Handle streaming text chunks from LLM
    socket.on('text_chunk', (chunk: string) => {
      setAiResponse(prev => {
        const newText = prev + chunk;
        globalTextLengthRef.current = newText.length;
        handleIncomingToken(chunk);
        return newText;
      });

      setTimeline(prev => {
        const next = [...prev];
        const lastIndex = next.length - 1;
        const lastMsg = next[lastIndex];
        if (lastMsg && lastMsg.role === 'model' && lastMsg.isStreaming) {
          next[lastIndex] = {
            ...lastMsg,
            text: lastMsg.text + chunk
          };
        } else {
          next.push({
            id: 'model-' + Date.now(),
            role: 'model',
            text: chunk,
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            isStreaming: true
          });
        }
        return next;
      });
    });

    // Handle AI object analysis result
    socket.on('object_analysis_result', (data: {
      className: string;
      imageFrame?: string;
      analysis: {
        shouldAdd: boolean;
        refinedLabel: string;
        type: 'device' | 'tool' | 'wire' | 'concept' | 'capacitor';
        details: string;
        relations: Array<{ target: string; relation: string }>;
      };
    }) => {
      const { className, imageFrame, analysis } = data;
      console.log(`[App] Received object analysis result for ${className}:`, analysis);

      if (!analysis.shouldAdd) {
        console.log(`[App] AI decided NOT to add ${className} to memory graph.`);
        return;
      }

      addAnalyzedObjectToGraph(className, analysis, imageFrame);

      setTimeline(prev => [
        ...prev,
        {
          id: 'user-detect-log-' + Date.now(),
          role: 'user',
          text: `[🔍 智能分析与建链] 发现并识别到物体 "${analysis.refinedLabel}" (${analysis.type})。AI 分析: "${analysis.details}"`,
          timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        }
      ]);
    });

    // 2. FSM state change listener
    fsmRef.current.registerStateListener((state) => {
      setAppState(state);
      if (state === 'LISTENING' || state === 'IDLE') {
        // Stop any current text-to-speech playing (browser)
        window.speechSynthesis.cancel();
        speechQueueRef.current = [];
        isSpeakingRef.current = false;
        charOffsetRef.current = 0;
        sentenceAccumulatorRef.current = '';
        globalTextLengthRef.current = 0;

        // Stop Aliyun CosyVoice playback
        isCosyVoiceActiveRef.current = false;
        if (audioSourceRef.current) {
          try {
            audioSourceRef.current.stop();
          } catch (e) {}
          audioSourceRef.current = null;
        }
        audioQueueRef.current = [];
        nextPlayIndexRef.current = 0;
        isAudioPlayingRef.current = false;
      } else {
        // Stop local ASR if we are thinking or speaking to avoid recording AI speech echo
        if (recognitionRef.current && isSpeechRecognitionActiveRef.current) {
          try {
            recognitionRef.current.abort();
          } catch (e) {
            console.error('Error aborting ASR on state change:', e);
          }
        }
      }
    });

    // 3. Set up camera feed
    navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        cameraStreamRef.current = stream;
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
      videoCaptureRef.current.stopCapture();
      if (cameraStreamRef.current) {
        cameraStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    if (timelineContainerRef.current) {
      timelineContainerRef.current.scrollTop = timelineContainerRef.current.scrollHeight;
    }
  }, [timeline]);

  const clearLogs = () => {
    setTimeline([]);
    setTranscription('');
    setAiResponse('');
    localSpeechTextRef.current = '';
    tempUserMsgIdRef.current = null;
    setDetectedObjects([]);

    isCosyVoiceActiveRef.current = false;
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) {}
      audioSourceRef.current = null;
    }
    audioQueueRef.current = [];
    nextPlayIndexRef.current = 0;
    isAudioPlayingRef.current = false;

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {}
    }
    socketRef.current?.emit('clear_history');

    // 清空图谱
    setGraphNodes([]);
    setGraphLinks([]);
    graphNodeSetRef.current.clear();
  };

  /**
   * 发送摄像头检测到的物体至后端，请求 AI 智能分析与关系评估
   */
  const emitAnalyzeDetectedObject = useCallback((className: string, imageBase64?: string) => {
    const existingNodeIds = Array.from(graphNodeSetRef.current);
    socketRef.current?.emit('analyze_detected_object', {
      className,
      imageFrame: imageBase64,
      existingNodes: existingNodeIds,
      llmProvider: llmProviderRef.current
    });
    console.log(`[App] Sent 'analyze_detected_object' request for: ${className}`);
  }, []);

  /**
   * 将后端 AI 确认且分析过的物体及智能关系链加入实体图谱
   */
  const addAnalyzedObjectToGraph = useCallback((
    className: string,
    analysis: {
      refinedLabel: string;
      type: 'device' | 'tool' | 'wire' | 'concept' | 'capacitor';
      details: string;
      relations: Array<{ target: string; relation: string }>;
    },
    imageBase64?: string
  ) => {
    const nodeId = className.toLowerCase().replace(/\s+/g, '_');

    if (graphNodeSetRef.current.has(nodeId)) {
      // 若已存在，更新为 AI 细化分析的数据
      setGraphNodes(prev => prev.map(node => {
        if (node.id === nodeId) {
          return {
            ...node,
            label: analysis.refinedLabel,
            type: analysis.type,
            details: analysis.details,
            image: imageBase64 || node.image
          };
        }
        return node;
      }));

      // 更新关系链
      if (analysis.relations && analysis.relations.length > 0) {
        setGraphLinks(prevLinks => {
          const updatedLinks = [...prevLinks];
          for (const rel of analysis.relations) {
            const linkExists = updatedLinks.some(l => {
              const s = typeof l.source === 'string' ? l.source : l.source.id;
              const t = typeof l.target === 'string' ? l.target : l.target.id;
              return (s === nodeId && t === rel.target) || (s === rel.target && t === nodeId);
            });
            if (!linkExists) {
              updatedLinks.push({
                source: nodeId,
                target: rel.target,
                relation: rel.relation
              });
            }
          }
          return updatedLinks;
        });
      }
      return;
    }

    graphNodeSetRef.current.add(nodeId);

    const newNode: GraphNode = {
      id: nodeId,
      label: analysis.refinedLabel,
      type: analysis.type,
      image: imageBase64 || undefined,
      details: analysis.details,
      firstSeen: new Date().toISOString()
    };

    setGraphNodes(prev => {
      const updated = [...prev, newNode];
      const newLinks: GraphLink[] = [];

      if (analysis.relations && analysis.relations.length > 0) {
        for (const rel of analysis.relations) {
          newLinks.push({
            source: nodeId,
            target: rel.target,
            relation: rel.relation
          });
        }
      } else {
        // AI 未返回特定关系时，降级与全部已有节点建立“同场景”关联
        for (const existing of prev) {
          newLinks.push({
            source: existing.id,
            target: nodeId,
            relation: '同场景'
          });
        }
      }

      if (newLinks.length > 0) {
        setGraphLinks(prevLinks => [...prevLinks, ...newLinks]);
      }

      return updated;
    });
  }, []);

  const handleGraphNodeClick = useCallback((node: GraphNode) => {
    setSelectedGraphNode(node);
  }, []);

  const initSpeechRecognition = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition is not supported in this browser.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';

    recognition.onstart = () => {
      console.log('Local ASR: Started');
      isSpeechRecognitionActiveRef.current = true;
    };

    recognition.onresult = (event: any) => {
      // Discard results if we are not in LISTENING state to prevent echo recording
      if (fsmRef.current.getCurrentState() !== 'LISTENING') {
        return;
      }

      let totalText = '';
      for (let i = 0; i < event.results.length; ++i) {
        totalText += event.results[i][0].transcript;
      }

      const currentText = totalText.trim();
      if (!currentText) return;

      // Update current User message in timeline in real-time
      setTimeline(prev => {
        const next = [...prev];
        const lastMsgIndex = next.map(m => m.id).lastIndexOf(tempUserMsgIdRef.current || '');
        if (lastMsgIndex !== -1) {
          next[lastMsgIndex] = {
            ...next[lastMsgIndex],
            text: currentText
          };
        } else {
          const newId = 'user-temp-' + Date.now();
          tempUserMsgIdRef.current = newId;
          next.push({
            id: newId,
            role: 'user',
            text: currentText,
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
        }
        return next;
      });

      localSpeechTextRef.current = currentText;
      setTranscription(currentText);
    };

    recognition.onerror = (event: any) => {
      console.error('Local ASR error:', event.error);
      if (event.error === 'no-speech') return;
    };

    recognition.onend = () => {
      console.log('Local ASR: Stopped');
      isSpeechRecognitionActiveRef.current = false;
      
      const isAIPaying = isSpeakingRef.current || isAudioPlayingRef.current;
      
      // Restart ASR if recording session is active, we are in LISTENING state, and AI is not playing
      if (
        fsmRef.current.getCurrentState() === 'LISTENING' && 
        mediaStreamRef.current && 
        !isAIPaying
      ) {
        try {
          recognition.start();
        } catch (e) {
          console.log('Ignore restart delay error:', e);
        }
      }
    };

    recognitionRef.current = recognition;
  };

  // Handle incoming tokens from LLM and assemble sentences for TTS
  const handleIncomingToken = (token: string) => {
    if (ttsProviderRef.current === 'cosyvoice') {
      return;
    }
    sentenceAccumulatorRef.current += token;
    
    // Check if the accumulated tokens end with a sentence delimiter
    const delimiters = ['。', '！', '？', '；', '.', '!', '?', '\n'];
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

  const playNextAudioChunk = async () => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    const targetIdx = audioQueueRef.current.findIndex(item => item.index === nextPlayIndexRef.current);
    if (targetIdx === -1) {
      isAudioPlayingRef.current = false;
      return;
    }

    isAudioPlayingRef.current = true;
    const { index, audio } = audioQueueRef.current.splice(targetIdx, 1)[0];
    nextPlayIndexRef.current = index + 1;

    try {
      const decodedBuffer = await ctx.decodeAudioData(audio.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(ctx.destination);
      audioSourceRef.current = source;

      source.onended = () => {
        audioSourceRef.current = null;
        playNextAudioChunk();
      };

      source.start(0);
    } catch (e) {
      console.error(`Error decoding or playing audio chunk index ${index}:`, e);
      playNextAudioChunk();
    }
  };

  // Turn on/off Microphone, start local VAD (Fallback RMS Threshold VAD)
  const startRecordingSession = async () => {
    // Initialize Web Audio context
    acousticProcessorRef.current.init();

    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      mediaStreamRef.current = stream;

      // Start environmental noise monitoring (Lombard Effect)
      if (noiseAdaptEnabled) {
        acousticProcessorRef.current.startNoiseMonitoring(stream);
      }

      fsmRef.current.transitionTo('LISTENING');
      setTranscription('正在听您说话...');
      setAiResponse('');

      // Initialize and start local SpeechRecognition
      initSpeechRecognition();
      try {
        recognitionRef.current?.start();
      } catch (e) {
        console.error('Failed to start local SpeechRecognition:', e);
      }

      // Setup audio analyser only for the visualizer
      const audioCtx = acousticProcessorRef.current.getAudioContext()!;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);

      // Setup Silero VAD (ONNX Neural Network VAD)
      const vad = await MicVAD.new({
        stream: stream,
        model: "v5",
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        onSpeechStart: () => {
          console.log("VAD: Speech started");
          
          // Check if AI is speaking and if we should suppress the interruption trigger (potential echo)
          const isAIPaying = isSpeakingRef.current || isAudioPlayingRef.current;
          if (isAIPaying && speechProbabilityRef.current < interruptThresholdRef.current) {
            console.log(`VAD start ignored (potential echo): probability ${speechProbabilityRef.current} is below ${(interruptThresholdRef.current * 100).toFixed(0)}% during AI playback`);
            return;
          }

          setIsUserSpeaking(true);
          const speechStartedAt = Date.now();
          currentSpeechStartedAtRef.current = speechStartedAt;
          isRecordingSpeechRef.current = true;
          speechChunksRef.current = [];

          // Initialize/Reset local text and temporary message ID for this new turn
          localSpeechTextRef.current = '';
          tempUserMsgIdRef.current = null;

          const mimeType = selectSpeechMimeType();
          const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
          mediaRecorderRef.current = recorder;
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              speechChunksRef.current.push(e.data);
            }
          };
          recorder.start();

          socketRef.current?.emit('vad_start', { speechStartedAt });
          // If AI is playing, this is an interruption!
          if (isSpeakingRef.current || isAudioPlayingRef.current) {
            console.log('Interruption detected!');
            window.speechSynthesis.cancel();

            if (audioSourceRef.current) {
              try {
                audioSourceRef.current.stop();
              } catch (e) {}
              audioSourceRef.current = null;
            }
            audioQueueRef.current = [];
            nextPlayIndexRef.current = 0;
            isAudioPlayingRef.current = false;

            socketRef.current?.emit('interrupt', { offset: charOffsetRef.current });

            // Frontend timeline truncation
            setTimeline(prev => {
              const next = [...prev];
              const lastMsgIndex = next.map(m => m.role).lastIndexOf('model');
              if (lastMsgIndex !== -1) {
                const lastMsg = next[lastMsgIndex];
                if (charOffsetRef.current < lastMsg.text.length) {
                  next[lastMsgIndex] = {
                    ...lastMsg,
                    text: lastMsg.text.substring(0, charOffsetRef.current) + "... [用户已打断]",
                    isStreaming: false
                  };
                }
              }
              return next;
            });

             // Reset and restart local ASR for the new user speech turn
             if (recognitionRef.current) {
               try {
                 recognitionRef.current.abort();
                 recognitionRef.current.start();
               } catch (e) {
                 console.log('Error restarting ASR on interrupt:', e);
               }
             }
          }
        },
        onSpeechEnd: () => {
          console.log("VAD: Speech ended");
          if (!isRecordingSpeechRef.current) {
            console.log("VAD end ignored: speech start was not recorded (ignored as potential echo)");
            return;
          }
          setIsUserSpeaking(false);
          triggerVADEnd();
        },
        onFrameProcessed: (probabilities) => {
          speechProbabilityRef.current = probabilities.isSpeech;
          // Update speech probability directly in DOM to avoid React re-render lag at high frequency
          const probEl = document.getElementById('vad-rms');
          if (probEl) {
            probEl.textContent = (probabilities.isSpeech * 100).toFixed(1) + "%";
          }
        }
      });
      vadRef.current = vad;
      vad.start();

      // Register callback to update bounding boxes overlay
      videoCaptureRef.current.registerOnPredictionsDetected((predictions) => {
        setDetectedObjects(predictions);
      });

      // Register local object detection callback to auto-trigger memory RAG retrieval
      videoCaptureRef.current.registerOnObjectDetected((className, base64Frame) => {
        // Only auto-trigger if the system is currently LISTENING (ready for interaction)
        if (fsmRef.current.getCurrentState() === 'LISTENING') {
          console.log(`[App] Auto-triggering RAG query for detected object: ${className}`);

          // 发起 AI 智能分析与关系评估后，再动态加入实体图谱
          emitAnalyzeDetectedObject(className, base64Frame);
          
          setTimeline(prev => [
            ...prev,
            {
              id: 'user-detect-' + Date.now(),
              role: 'user',
              text: `[🔍 视觉检测] 我手里正拿着一个"${className}"，请根据当前画面，帮我检索并回忆有关它的情景记忆。`,
              timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            }
          ]);

          socketRef.current?.emit('text_query', {
            text: `我手里拿着一个"${className}"，帮我回忆关于它的长程多模态情景记忆。`,
            llmProvider: llmProviderRef.current,
            ttsProvider: ttsProviderRef.current,
            imageFrame: base64Frame
          });
        }
      });

      // Start VideoCapture sliding window buffer (2fps) with QualityGuard checks on the DOM video element
      if (videoRef.current) {
        videoCaptureRef.current.startCapture(videoRef.current);
      } else {
        console.warn('Video element not available for VideoCapture');
      }

      // Render audio visualizer on canvas
      renderVisualizer(analyser);

    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  };

  const triggerVADEnd = () => {
    console.log('Silence detected, triggering VAD End');
    const speechStartedAt = currentSpeechStartedAtRef.current;
    if (!speechStartedAt) {
      console.log('Ignoring VAD end because no speech start was recorded.');
      isRecordingSpeechRef.current = false;
      return;
    }

    const endedAt = Date.now();
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      console.log('Ignoring VAD end because no active speech recorder exists.');
      isRecordingSpeechRef.current = false;
      currentSpeechStartedAtRef.current = null;
      return;
    }

    recorder.onstop = async () => {
      const audioBlob = new Blob(speechChunksRef.current, { type: recorder.mimeType || speechChunksRef.current[0]?.type || 'audio/webm' });
      speechChunksRef.current = [];

      // Get aligned frames from VideoCapture
      const { startFrame, endFrame } = videoCaptureRef.current.getAlignedFrames(
        speechStartedAt,
        endedAt
      );

      // Perform QualityGuard check on the end frame (the most relevant scene frame)
      if (endFrame) {
        if (!endFrame.brightness.passed) {
          console.warn(`Quality check failed (brightness): ${endFrame.brightness.reason}`);
          
          // Intercept sending and speak warning locally using SpeechSynthesis
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance(
            endFrame.brightness.score && endFrame.brightness.score < 40 
              ? '当前环境光线过暗，请开启灯光后再试。' 
              : '当前画面过曝，请调整相机角度或光源后再试。'
          );
          utterance.lang = 'zh-CN';
          window.speechSynthesis.speak(utterance);
          
          // Reset UI/Recorder state
          setIsUserSpeaking(false);
          isRecordingSpeechRef.current = false;
          mediaRecorderRef.current = null;
          fsmRef.current.transitionTo('LISTENING');
          
          // Remove temporary message from timeline
          if (tempUserMsgIdRef.current) {
            setTimeline(prev => prev.filter(m => m.id !== tempUserMsgIdRef.current));
          }
          tempUserMsgIdRef.current = null;
          localSpeechTextRef.current = '';

          // Re-init SpeechRecognition
          if (recognitionRef.current && !isSpeechRecognitionActiveRef.current) {
            try {
              recognitionRef.current.start();
            } catch (e) {}
          }
          return;
        }

        if (!endFrame.blur.passed) {
          console.warn(`Quality check failed (blur): ${endFrame.blur.reason}`);
          
          // Intercept sending and speak warning locally using SpeechSynthesis
          window.speechSynthesis.cancel();
          const utterance = new SpeechSynthesisUtterance('当前画面过于模糊，请稳住相机后再试。');
          utterance.lang = 'zh-CN';
          window.speechSynthesis.speak(utterance);
          
          // Reset UI/Recorder state
          setIsUserSpeaking(false);
          isRecordingSpeechRef.current = false;
          mediaRecorderRef.current = null;
          fsmRef.current.transitionTo('LISTENING');
          
          // Remove temporary message from timeline
          if (tempUserMsgIdRef.current) {
            setTimeline(prev => prev.filter(m => m.id !== tempUserMsgIdRef.current));
          }
          tempUserMsgIdRef.current = null;
          localSpeechTextRef.current = '';

          // Re-init SpeechRecognition
          if (recognitionRef.current && !isSpeechRecognitionActiveRef.current) {
            try {
              recognitionRef.current.start();
            } catch (e) {}
          }
          return;
        }
      }

      if (audioBlob.size > 0) {
        const buffer = await audioBlob.arrayBuffer();
        socketRef.current?.emit('audio_chunk', {
          data: buffer,
          mimeType: audioBlob.type
        });
      }

      socketRef.current?.emit('vad_end', {
        speechStartedAt,
        speechEndedAt: endedAt,
        localText: localSpeechTextRef.current,
        llmProvider: llmProviderRef.current,
        ttsProvider: ttsProviderRef.current,
        startFrame: startFrame ? startFrame.imageBase64 : undefined,
        endFrame: endFrame ? endFrame.imageBase64 : undefined
      });
      isRecordingSpeechRef.current = false;
      mediaRecorderRef.current = null;
    };

    recorder.stop();

    currentSpeechStartedAtRef.current = null;
    fsmRef.current.transitionTo('THINKING');

    // Abort local ASR to stop transcription during AI output
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {
        console.error('Error aborting ASR on speech end:', e);
      }
    }
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

    isCosyVoiceActiveRef.current = false;
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) {}
      audioSourceRef.current = null;
    }
    audioQueueRef.current = [];
    nextPlayIndexRef.current = 0;
    isAudioPlayingRef.current = false;

    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch (e) {}
    }
    localSpeechTextRef.current = '';
    tempUserMsgIdRef.current = null;
    if (vadRef.current) {
      try {
        vadRef.current.destroy();
      } catch (err) {
        console.error('Error destroying VAD:', err);
      }
      vadRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    videoCaptureRef.current.stopCapture();
    setDetectedObjects([]);
    fsmRef.current.transitionTo('IDLE');
    setTranscription('');
    setAiResponse('');
    setIsUserSpeaking(false);
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

  const handleScreenshotSave = (bbox: [number, number, number, number], className: string) => {
    const dataUrl = videoCaptureRef.current.getCroppedFrame(bbox);
    if (dataUrl) {
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `crop_${className.replace(/\s+/g, '_')}_${Date.now()}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      alert('无法获取截屏，请确保摄像头已开启并正常识别中。');
    }
  };

  return (
    <div className="app-root">
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

      {/* Compact Header */}
      <header className="app-header">
        <div>
          <h1 style={{ fontSize: '18px', color: '#00f2fe', textShadow: '0 0 10px rgba(0, 242, 254, 0.5)' }}>
            AI VISION DIALOGUE ASSISTANT
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '11px' }}>双工音视频协同 & 长程多模态情景记忆 V1.0</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={() => setShowGraph(prev => !prev)}
            className="btn-neon"
            style={{ padding: '4px 12px', fontSize: '11px', borderRadius: '4px' }}
          >
            🧠 记忆图谱 ({graphNodes.length})
          </button>
          <span className={`led-dot led-${appState.toLowerCase()}`}></span>
          <span style={{ fontFamily: 'Orbitron', fontSize: '13px', textTransform: 'uppercase' }}>
            {appState}
          </span>
          <span style={{ fontSize: '11px', color: socketConnected ? '#10b981' : '#f43f5e', border: '1px solid currentColor', padding: '2px 8px', borderRadius: '4px' }}>
            {socketConnected ? 'GATEWAY ONLINE' : 'GATEWAY OFFLINE'}
          </span>
        </div>
      </header>

      {/* Main 3-Column Area */}
      <div className="main-area">
        {/* === LEFT: Camera Feed & Detection === */}
        <div className="cyber-card">
          <h2 style={{ fontSize: '13px', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '6px' }}>
            📷 CAMERA FEED
          </h2>
          
          {/* Camera Frame Box */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#000', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border-neon)' }}>
            <video ref={videoRef} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} />
            
            {/* Object Detection Overlay Bounding Boxes */}
            <svg 
              viewBox="0 0 640 480" 
              style={{ 
                position: 'absolute', 
                top: 0, 
                left: 0, 
                width: '100%', 
                height: '100%', 
                pointerEvents: 'none', 
                zIndex: 10 
              }}
            >
              {detectedObjects.map((obj, i) => {
                const [x, y, w, h] = obj.bbox;
                // Flip coordinates mathematically in JS (since video is mirrored using scaleX(-1))
                // Center of the 640-wide SVG coordinate space is 320.
                const mirroredX = 640 - x - w;
                return (
                  <g key={i}>
                    {/* Bounding box rect */}
                    <rect
                      x={mirroredX}
                      y={y}
                      width={w}
                      height={h}
                      fill="none"
                      stroke="#39ff14"
                      strokeWidth="3"
                      style={{ filter: 'drop-shadow(0 0 5px #39ff14)' }}
                    />
                    {/* Object class name & confidence tag (No nested flips needed now) */}
                    <g transform={`translate(${mirroredX}, ${y - 10})`}>
                      <text
                        x={0}
                        y={0}
                        textAnchor="start"
                        fill="#39ff14"
                        style={{
                          fontSize: '18px',
                          fontFamily: 'Orbitron, sans-serif',
                          fontWeight: 'bold',
                          textShadow: '0 0 8px #39ff14, 1px 1px 2px #000'
                        }}
                      >
                        {obj.class} ({(obj.score * 100).toFixed(0)}%)
                      </text>
                    </g>
                  </g>
                );
              })}
            </svg>

            {/* Debug Info Overlay */}
            <div style={{ position: 'absolute', top: '10px', right: '10px', background: 'rgba(0,0,0,0.8)', color: '#00f2fe', padding: '6px 12px', borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace', zIndex: 30, pointerEvents: 'none', border: '1px solid rgba(0, 242, 254, 0.3)' }}>
              <div>Video Intrinsic: {videoRef.current ? `${videoRef.current.videoWidth}x${videoRef.current.videoHeight}` : 'unknown'}</div>
              <div>Canvas Size: 640x480</div>
              <div>Predictions Count: {detectedObjects.length}</div>
              {detectedObjects.length > 0 && (
                <div>Box[0]: {JSON.stringify(detectedObjects[0].bbox.map((n: number) => Math.round(n)))}</div>
              )}
            </div>

            <div style={{ position: 'absolute', bottom: '10px', left: '10px', display: 'flex', gap: '10px', alignItems: 'center', zIndex: 20 }}>
              <span className={`led-dot led-${appState === 'LISTENING' ? 'listening' : 'idle'}`}></span>
              <span style={{ fontSize: '12px', color: '#fff', textShadow: '1px 1px 2px #000' }}>
                {appState === 'LISTENING' ? 'MIC RECORDING' : 'MIC MUTE'}
              </span>
            </div>
          </div>

          {/* 🔍 识别物品与截屏调试 */}
          <div className="col-scroll" style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '10px', border: '1px solid rgba(0, 242, 254, 0.15)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: '#00f2fe', fontFamily: 'Orbitron', textTransform: 'uppercase', display: 'block', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '4px', flexShrink: 0 }}>
              🔍 识别物品 (Detected Objects)
            </span>
            {detectedObjects.length === 0 ? (
              <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0, fontStyle: 'italic' }}>
                当前未检测到任何物品，请将物品置于镜头前...
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {detectedObjects.map((obj, i) => {
                  const [x, y, w, h] = obj.bbox;
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.03)', padding: '6px 12px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.05)' }}>
                      <div>
                        <strong style={{ color: '#39ff14', fontSize: '14px' }}>{obj.class}</strong>
                        <span style={{ color: '#94a3b8', fontSize: '12px', marginLeft: '8px' }}>
                          置信度: {(obj.score * 100).toFixed(0)}%
                        </span>
                        <div style={{ color: '#64748b', fontSize: '10px', fontFamily: 'monospace', marginTop: '2px' }}>
                          bbox: [{Math.round(x)}, {Math.round(y)}, {Math.round(w)}, {Math.round(h)}]
                        </div>
                      </div>
                      <button 
                        onClick={() => handleScreenshotSave(obj.bbox, obj.class)}
                        style={{
                          background: 'linear-gradient(135deg, #00f2fe, #4facfe)',
                          color: '#000',
                          border: 'none',
                          padding: '4px 10px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          boxShadow: '0 0 8px rgba(0, 242, 254, 0.4)',
                          transition: 'transform 0.1s ease'
                        }}
                        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.95)')}
                        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
                      >
                        📸 截屏保存
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* User Transcription Box */}
          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: '8px', padding: '10px', border: '1px solid rgba(255,255,255,0.05)', minHeight: '50px', flexShrink: 0 }}>
            <span style={{ fontSize: '10px', color: '#00f2fe', fontFamily: 'Orbitron', textTransform: 'uppercase', display: 'block', marginBottom: '3px' }}>
              USER INPUT
            </span>
            <p style={{ fontSize: '13px', color: '#e2e8f0', lineHeight: '1.4' }}>
              {transcription || '请直接对着麦克风说话...'}
            </p>
          </div>
        </div>

        {/* === CENTER: Dialogue Timeline & Controls === */}
        <div className="cyber-card">
          {/* Timeline Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '6px', flexShrink: 0 }}>
            <span style={{ fontSize: '12px', color: '#a855f7', fontFamily: 'Orbitron', textTransform: 'uppercase', fontWeight: 'bold' }}>
              💬 DIALOGUE TIMELINE
            </span>
            <button 
              onClick={clearLogs} 
              className="btn-neon btn-neon-rose"
              style={{ padding: '3px 10px', fontSize: '10px', borderRadius: '4px' }}
            >
              CLEAR LOGS
            </button>
          </div>

          {/* Timeline - fills space, scrolls internally */}
          <div className="timeline-container" ref={timelineContainerRef}>
            <div className="timeline-line"></div>
            {timeline.length === 0 ? (
              <div style={{ display: 'flex', height: '100%', justifyContent: 'center', alignItems: 'center', color: '#64748b', fontSize: '14px', fontFamily: 'Outfit' }}>
                {appState === 'THINKING' ? 'AI 正在思考中，请稍候...' : '等待您的提问，直接对着麦克风说话即可开始录音...'}
              </div>
            ) : (
              timeline.map((msg) => (
                <div key={msg.id} className="timeline-item">
                  <div className={`timeline-node timeline-node-${msg.role} ${msg.isStreaming ? 'timeline-node-active' : ''}`}></div>
                  <div className={`timeline-bubble timeline-bubble-${msg.role}`}>
                    <div className="timeline-meta">
                      <span className={`timeline-role-${msg.role}`}>
                        {msg.role === 'user' ? 'USER' : 'ASSISTANT'}
                      </span>
                      <span className="timeline-time">{msg.timestamp}</span>
                    </div>
                    <div className="timeline-text">
                      {msg.text}
                      {msg.isStreaming && <span className="typing-cursor"></span>}
                    </div>
                  </div>
                </div>
              ))
            )}
            <div ref={timelineEndRef} />
          </div>

          {/* Controls / Status Bar */}
          <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column', gap: '6px', paddingTop: '6px' }}>
            <div 
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 24px',
                borderRadius: '50px',
                background: isUserSpeaking ? 'rgba(0, 242, 254, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                border: isUserSpeaking ? '1px solid #00f2fe' : '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: isUserSpeaking ? '0 0 25px rgba(0, 242, 254, 0.4)' : 'none',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                pointerEvents: 'none',
                userSelect: 'none'
              }}
            >
              <div 
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  background: isUserSpeaking ? '#00f2fe' : '#475569',
                  boxShadow: isUserSpeaking ? '0 0 10px #00f2fe' : 'none',
                }}
              />
              <svg 
                style={{ width: '18px', height: '18px', color: isUserSpeaking ? '#00f2fe' : '#475569', transition: 'color 0.3s ease' }} 
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '13px', fontWeight: 'bold', color: isUserSpeaking ? '#00f2fe' : '#475569', letterSpacing: '1px', transition: 'color 0.3s ease' }}>
                {isUserSpeaking ? 'USER SPEAKING' : 'USER SILENT'}
              </span>
            </div>
            {/* VAD HUD Dashboard */}
            <div 
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: '12px',
                padding: '6px 16px',
                borderRadius: '8px',
                background: 'rgba(10, 11, 16, 0.6)',
                border: '1px solid rgba(0, 242, 254, 0.15)',
                fontFamily: 'Orbitron, monospace',
                fontSize: '10px',
                color: '#8a99ad',
                boxShadow: '0 0 10px rgba(0, 242, 254, 0.05)',
                userSelect: 'none'
              }}
            >
              <div>
                SPEECH: <span id="vad-rms" style={{ color: '#ffffff', fontWeight: 'bold' }}>0.0%</span>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
              <div>
                阈值: <span style={{ color: '#ff007f', fontWeight: 'bold' }}>50% / {(interruptThreshold * 100).toFixed(0)}%</span>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
              <div>
                LLM: <span style={{ color: '#00f2fe', fontWeight: 'bold' }}>{llmProvider === 'dashscope' ? '通义' : 'OpenRouter'}</span>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
              <div>
                TTS: <span style={{ color: '#ffcc00', fontWeight: 'bold' }}>{ttsProvider === 'cosyvoice' ? 'CosyVoice' : 'Browser'}</span>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }} />
              <div>
                VAD: <span style={{ color: '#39ff14', fontWeight: 'bold' }}>Silero</span>
              </div>
            </div>
            <p style={{ fontSize: '10px', color: '#64748b', margin: 0, fontFamily: 'sans-serif' }}>
              {socketConnected ? '双工声音感应器已激活，直接开口说话可打断 AI' : '等待网关连接...'}
            </p>
          </div>
        </div>

        {/* === RIGHT: Canvas & Config === */}
        <div className="cyber-card">
          <h2 style={{ fontSize: '13px', color: '#e2e8f0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '6px' }}>
            🎨 SCHEMATIC CANVAS
          </h2>

          {/* Drawing Canvas Box */}
          <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', background: '#121420', borderRadius: '8px', border: '1px solid var(--border-neon-purple)' }}>
            <canvas ref={canvasRef} width={400} height={300} style={{ width: '100%', height: '100%', display: 'block' }} />
          </div>

          {/* Configuration Panel */}
          <div className="col-scroll" style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '10px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px' }}>
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                Acoustic Reverb (混响效果)
              </label>
              <select 
                value={reverbPreset} 
                onChange={handleReverbChange}
                style={{ width: '100%', background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '8px', borderRadius: '4px', cursor: 'pointer' }}
              >
                <option value="studio">录音棚 (Studio)</option>
                <option value="living">客厅 (Living Room)</option>
                <option value="hall">教堂大厅 (Hall)</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                Lombard Volume Adapt (噪音自适应)
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
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                LLM Provider (大模型提供商)
              </label>
              <select 
                value={llmProvider} 
                onChange={(e) => setLlmProvider(e.target.value)}
                style={{ width: '100%', background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', padding: '8px', borderRadius: '4px', cursor: 'pointer' }}
              >
                <option value="dashscope">阿里通义 (DashScope)</option>
                <option value="openrouter">OpenRouter 官方</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '8px' }}>
                TTS Engine (语音播放引擎)
              </label>
              <div style={{ display: 'flex', gap: '5px', background: '#1e293b', padding: '3px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.1)' }}>
                <button
                  type="button"
                  onClick={() => setTtsProvider('cosyvoice')}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    fontSize: '11px',
                    fontFamily: 'Outfit, sans-serif',
                    fontWeight: 600,
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    background: ttsProvider === 'cosyvoice' ? 'var(--neon-cyan)' : 'transparent',
                    color: ttsProvider === 'cosyvoice' ? 'var(--bg-dark)' : 'var(--text-muted)',
                    boxShadow: ttsProvider === 'cosyvoice' ? '0 0 10px rgba(0, 242, 254, 0.4)' : 'none',
                    transition: 'all 0.3s ease'
                  }}
                >
                  阿里 CosyVoice
                </button>
                <button
                  type="button"
                  onClick={() => setTtsProvider('browser')}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    fontSize: '11px',
                    fontFamily: 'Outfit, sans-serif',
                    fontWeight: 600,
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    background: ttsProvider === 'browser' ? 'var(--neon-purple)' : 'transparent',
                    color: ttsProvider === 'browser' ? '#ffffff' : 'var(--text-muted)',
                    boxShadow: ttsProvider === 'browser' ? '0 0 10px rgba(168, 85, 247, 0.4)' : 'none',
                    transition: 'all 0.3s ease'
                  }}
                >
                  浏览器机械音
                </button>
              </div>
            </div>
            <div>
              <label style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', display: 'block', marginBottom: '5px' }}>
                AI播音时打断概率阈值 (Interruption Threshold during Playback)
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                <input 
                  type="range" 
                  min="0.5" 
                  max="0.95" 
                  step="0.05"
                  value={interruptThreshold} 
                  onChange={(e) => setInterruptThreshold(parseFloat(e.target.value))}
                  style={{ flex: 1, cursor: 'pointer', accentColor: '#00f2fe' }}
                />
                <span style={{ fontSize: '14px', color: '#00f2fe', width: '50px', fontFamily: 'Orbitron, monospace', fontWeight: 'bold' }}>
                  {(interruptThreshold * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* === Memory Graph Modal Overlay === */}
      {showGraph && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}
          onClick={() => setShowGraph(false)}
        >
          <div
            className="cyber-card"
            style={{ width: '100%', maxWidth: '1100px', maxHeight: '90vh', overflow: 'auto', border: '1px solid rgba(0, 242, 254, 0.3)' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '10px', marginBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '12px', color: '#00f2fe', fontFamily: 'Orbitron', textTransform: 'uppercase', fontWeight: 'bold' }}>
                  🧠 ENTITY MEMORY GRAPH
                </span>
                <span style={{ fontSize: '11px', color: '#64748b', fontFamily: 'monospace' }}>
                  {graphNodes.length} nodes · {graphLinks.length} links
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => {
                    detectedObjects.forEach(obj => {
                      const frame = videoCaptureRef.current.getLatestFrame?.();
                      emitAnalyzeDetectedObject(obj.class, frame || undefined);
                    });
                  }}
                  className="btn-neon"
                  style={{ padding: '4px 12px', fontSize: '10px', borderRadius: '4px', opacity: detectedObjects.length > 0 ? 1 : 0.4 }}
                  disabled={detectedObjects.length === 0}
                >
                  + 导入当前检测物体
                </button>
                <button
                  onClick={() => setShowGraph(false)}
                  className="btn-neon btn-neon-rose"
                  style={{ padding: '4px 12px', fontSize: '10px', borderRadius: '4px' }}
                >
                  ✕ 关闭
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '16px', minHeight: '440px' }}>
              {/* 左侧：D3 力学图谱 */}
              <div style={{ flex: 2 }}>
                {graphNodes.length === 0 ? (
                  <div style={{
                    display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                    height: '100%', minHeight: '400px', borderRadius: '12px',
                    border: '1px dashed rgba(0, 242, 254, 0.2)', background: '#0b0f19',
                    color: '#4a5568', fontFamily: "'Inter', sans-serif", textAlign: 'center', padding: '40px'
                  }}>
                    <div style={{ fontSize: '48px', marginBottom: '16px', opacity: 0.5 }}>🧠</div>
                    <div style={{ fontSize: '14px', marginBottom: '8px' }}>实体图谱为空</div>
                    <div style={{ fontSize: '12px', color: '#3a4553', lineHeight: 1.6 }}>
                      将物品放置在摄像头前方，系统会自动检测并识别。<br/>
                      点击上方「导入当前检测物体」按钮将物品添加到图谱中。<br/>
                      或者，在对话过程中系统会自动提取实体关系。
                    </div>
                  </div>
                ) : (
                  <D3GraphRenderer
                    nodes={graphNodes}
                    links={graphLinks}
                    onNodeClick={handleGraphNodeClick}
                  />
                )}
              </div>

              {/* 右侧：节点详情面板 + 节点列表 */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '320px' }}>
                {/* 选中节点详情 */}
                {selectedGraphNode ? (
                  <div style={{
                    background: 'rgba(10, 14, 28, 0.9)', borderRadius: '10px',
                    border: '1px solid rgba(0, 242, 254, 0.2)', padding: '16px',
                    backdropFilter: 'blur(8px)'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                      <span style={{ color: '#00f2fe', fontFamily: 'Orbitron', fontSize: '11px', textTransform: 'uppercase' }}>NODE DETAILS</span>
                      <button onClick={() => setSelectedGraphNode(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '14px' }}>✕</button>
                    </div>
                    {selectedGraphNode.image && (
                      <div style={{ marginBottom: '12px', borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(0,242,254,0.15)' }}>
                        <img
                          src={selectedGraphNode.image.startsWith('data:') ? selectedGraphNode.image : `data:image/jpeg;base64,${selectedGraphNode.image}`}
                          alt={selectedGraphNode.label}
                          style={{ width: '100%', height: 'auto', display: 'block' }}
                        />
                      </div>
                    )}
                    <div style={{ color: '#e2e8f0', fontWeight: 700, fontSize: '16px', marginBottom: '6px' }}>{selectedGraphNode.label}</div>
                    <div style={{ display: 'inline-block', padding: '2px 10px', borderRadius: '10px', fontSize: '11px', background: 'rgba(0,242,254,0.1)', color: '#00f2fe', border: '1px solid rgba(0,242,254,0.3)', marginBottom: '10px' }}>
                      {selectedGraphNode.type}
                    </div>
                    {selectedGraphNode.details && (
                      <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: 1.5, marginBottom: '8px' }}>
                        📋 {selectedGraphNode.details}
                      </div>
                    )}
                    {selectedGraphNode.firstSeen && (
                      <div style={{ fontSize: '11px', color: '#4a5568' }}>
                        🕐 首次发现: {new Date(selectedGraphNode.firstSeen).toLocaleString('zh-CN')}
                      </div>
                    )}
                    {/* 显示关联的边 */}
                    <div style={{ marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '8px' }}>
                      <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px' }}>🔗 关联节点</div>
                      {graphLinks
                        .filter(l => {
                          const s = typeof l.source === 'string' ? l.source : l.source.id;
                          const t = typeof l.target === 'string' ? l.target : l.target.id;
                          return s === selectedGraphNode.id || t === selectedGraphNode.id;
                        })
                        .map((l, i) => {
                          const s = typeof l.source === 'string' ? l.source : l.source.id;
                          const t = typeof l.target === 'string' ? l.target : l.target.id;
                          const otherId = s === selectedGraphNode.id ? t : s;
                          return (
                            <div key={i} style={{ fontSize: '12px', color: '#8a99ad', padding: '2px 0' }}>
                              → <span style={{ color: '#00f2fe' }}>{otherId}</span>
                              <span style={{ color: '#4a5568', marginLeft: '6px' }}>({l.relation})</span>
                            </div>
                          );
                        })
                      }
                      {graphLinks.filter(l => {
                        const s = typeof l.source === 'string' ? l.source : l.source.id;
                        const t = typeof l.target === 'string' ? l.target : l.target.id;
                        return s === selectedGraphNode.id || t === selectedGraphNode.id;
                      }).length === 0 && (
                        <div style={{ fontSize: '11px', color: '#3a4553', fontStyle: 'italic' }}>暂无关联</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ background: 'rgba(10, 14, 28, 0.6)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', textAlign: 'center', color: '#4a5568', fontSize: '12px' }}>
                    点击图谱中的节点查看详情
                  </div>
                )}

                {/* 节点列表 */}
                <div style={{ flex: 1, background: 'rgba(10,14,28,0.5)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)', padding: '12px', overflowY: 'auto', maxHeight: '260px' }}>
                  <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px', fontFamily: 'Orbitron', textTransform: 'uppercase' }}>All Nodes</div>
                  {graphNodes.map(node => (
                    <div
                      key={node.id}
                      onClick={() => setSelectedGraphNode(node)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '8px',
                        padding: '8px 10px', borderRadius: '6px', cursor: 'pointer',
                        background: selectedGraphNode?.id === node.id ? 'rgba(0,242,254,0.08)' : 'transparent',
                        border: selectedGraphNode?.id === node.id ? '1px solid rgba(0,242,254,0.2)' : '1px solid transparent',
                        marginBottom: '4px',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {/* 缩略图 */}
                      {node.image ? (
                        <img
                          src={node.image.startsWith('data:') ? node.image : `data:image/jpeg;base64,${node.image}`}
                          alt={node.label}
                          style={{ width: 36, height: 36, borderRadius: 6, objectFit: 'cover', border: '1px solid rgba(0,242,254,0.15)', flexShrink: 0 }}
                        />
                      ) : (
                        <div style={{ width: 36, height: 36, borderRadius: 6, background: 'rgba(0,242,254,0.05)', border: '1px solid rgba(0,242,254,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 }}>
                          {node.type === 'device' ? '⚡' : node.type === 'tool' ? '🔧' : '◆'}
                        </div>
                      )}
                      <div style={{ overflow: 'hidden' }}>
                        <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.label}</div>
                        <div style={{ color: '#4a5568', fontSize: '10px' }}>{node.type}</div>
                      </div>
                    </div>
                  ))}
                  {graphNodes.length === 0 && (
                    <div style={{ textAlign: 'center', color: '#3a4553', fontSize: '11px', padding: '20px 0' }}>空</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}