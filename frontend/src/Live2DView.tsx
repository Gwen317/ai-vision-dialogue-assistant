import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Application, Ticker } from 'pixi.js';
import { Live2DModel, config as live2dConfig } from 'pixi-live2d-display';

export interface Live2DModelOption {
  label: string;
  url: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export const LIVE2D_MODELS: Live2DModelOption[] = [
  { label: 'Hijiki (黑猫)', url: '/live2d/hijiki/hijiki.model.json' },
  { label: 'Shizuku (雫)', url: '/live2d/shizuku/shizuku.model.json' },
  { label: 'Koharu (小春)', url: '/live2d/koharu/koharu.model.json' },
];

const STORAGE_KEY = 'live2d_model_url';
const CUSTOM_PREFIX = '__custom__';
export const DEFAULT_LIVE2D_MODEL_URL = LIVE2D_MODELS[0].url;

interface CoreModelLike {
  setParameterValueById?: (id: string, value: number) => void;
  setParamFloat?: (id: string, value: number) => void;
}

interface Live2DViewProps {
  aiText: string;
  appState: 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';
  isAiAudioPlaying?: boolean;
  modelUrl?: string;
  onModelChange?: (url: string) => void;
}

function cleanBubbleText(text: string): string {
  return text.replace(/^\[.*?\]\s*/s, '').trim();
}

export function Live2DView({
  aiText,
  appState,
  isAiAudioPlaying = false,
  modelUrl,
  onModelChange,
}: Live2DViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const modelRef = useRef<Live2DModel | null>(null);
  const isSpeakingRef = useRef(false);
  const lipSyncPhaseRef = useRef(0);

  const isSpeaking = isAiAudioPlaying || appState === 'SPEAKING';

  const [modelLoaded, setModelLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadLog, setLoadLog] = useState('');
  const motionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Custom URL input state
  const storedUrl = modelUrl || localStorage.getItem(STORAGE_KEY) || '';
  const isPreset = LIVE2D_MODELS.some((m) => m.url === storedUrl);
  const selectValue = isPreset ? storedUrl : CUSTOM_PREFIX;
  const [showCustomInput, setShowCustomInput] = useState(!isPreset && !!storedUrl);
  const [customUrl, setCustomUrl] = useState(!isPreset ? storedUrl : '');

  const resolvedModelUrl = storedUrl || DEFAULT_LIVE2D_MODEL_URL;

  // Bubble stays visible through SPEAKING -> LISTENING -> IDLE,
  // only clears when THINKING starts (new interaction, aiText reset to '')
  const bubbleText = useMemo(() => {
    if (aiText && appState !== 'THINKING') {
      return cleanBubbleText(aiText);
    }
    return '';
  }, [aiText, appState]);

  // Initialize PixiJS + Live2D model
  useEffect(() => {
    let cancelled = false;
    const wrapper = canvasWrapperRef.current;

    const init = async () => {
      if (!wrapper) return;

      // Check runtime scripts are loaded
      const w = window as unknown as {
        Live2DCubismCore?: unknown;
        Live2DModelWebGL?: unknown;
      };
      const hasCubism4 = typeof w.Live2DCubismCore !== 'undefined';
      const hasCubism2 = typeof w.Live2DModelWebGL !== 'undefined';
      console.log('[Live2DView] Runtime check - Cubism4:', hasCubism4, 'Cubism2:', hasCubism2);
      setLoadLog(
        hasCubism4 || hasCubism2
          ? '运行时已加载，正在加载模型...'
          : '警告: Live2D 运行时未加载!'
      );

      if (!hasCubism4 && !hasCubism2) {
        if (!cancelled)
          setLoadError('Live2D 运行时未加载，请检查 /vendor/ 脚本是否存在');
        return;
      }

      const width = wrapper.clientWidth || 300;
      const height = wrapper.clientHeight || 280;

      console.log('[Live2DView] Creating PIXI app', { width, height });
      const app = new Application({
        backgroundAlpha: 0,
        antialias: true,
        width,
        height,
      });
      appRef.current = app;
      wrapper.appendChild(app.view);

      Live2DModel.registerTicker(Ticker);
      live2dConfig.sound = false;

      // Lip-sync ticker
      app.ticker.add((delta) => {
        const model = modelRef.current;
        const internal = model?.internalModel as { coreModel?: CoreModelLike } | undefined;
        const core = internal?.coreModel;
        if (!core) return;

        let mouthValue = 0;
        if (isSpeakingRef.current) {
          lipSyncPhaseRef.current += delta * 0.4;
          const base = Math.abs(Math.sin(lipSyncPhaseRef.current));
          mouthValue = Math.min(1, base * 1.1 + 0.05);
        } else {
          lipSyncPhaseRef.current = 0;
        }

        try {
          core.setParameterValueById?.('ParamMouthOpenY', mouthValue);
        } catch {
          try {
            core.setParamFloat?.('PARAM_MOUTH_OPEN_Y', mouthValue);
          } catch {
            /* parameter not available */
          }
        }
      });

      try {
        console.log('[Live2DView] Loading model from:', resolvedModelUrl);
        setLoadLog('正在加载模型文件...');
        const model = await Live2DModel.from(resolvedModelUrl);
        console.log('[Live2DView] Model loaded successfully', {
          width: model.width,
          height: model.height,
        });

        if (cancelled) {
          model.destroy();
          return;
        }

        modelRef.current = model;
        app.stage.addChild(model);

        // Scale & center
        const fitScale =
          Math.min(app.screen.width / model.width, app.screen.height / model.height) * 0.95;
        model.scale.set(fitScale);
        model.anchor.set(0.5, 0.5);
        model.x = app.screen.width / 2;
        model.y = app.screen.height / 2;

        model.on('hit', () => {
          try {
            model.motion('idle');
          } catch {
            try {
              model.motion('Idle');
            } catch {
              /* no idle motion */
            }
          }
        });

        setModelLoaded(true);
        setLoadError(null);
        setLoadLog('');

        // Periodic idle motion
        motionTimerRef.current = setInterval(() => {
          if (!isSpeakingRef.current && modelRef.current) {
            try {
              modelRef.current.motion('idle');
            } catch {
              try {
                modelRef.current.motion('Idle');
              } catch {
                /* no idle motion */
              }
            }
          }
        }, 8000);
      } catch (err) {
        console.error('[Live2DView] Failed to load model:', err);
        if (!cancelled) {
          setLoadError(
            `模型加载失败: ${err instanceof Error ? err.message : String(err)}\nURL: ${resolvedModelUrl}`
          );
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      if (motionTimerRef.current) {
        clearInterval(motionTimerRef.current);
        motionTimerRef.current = null;
      }
      if (modelRef.current) {
        try {
          modelRef.current.destroy();
        } catch {
          /* cleanup */
        }
        modelRef.current = null;
      }
      if (appRef.current) {
        try {
          appRef.current.destroy(true, { children: true });
        } catch {
          /* cleanup */
        }
        appRef.current = null;
      }
      setModelLoaded(false);
    };
  }, [resolvedModelUrl]);

  // Sync speaking ref + trigger a silent model motion
  useEffect(() => {
    isSpeakingRef.current = isSpeaking;

    if (isSpeaking && modelRef.current) {
      const groups = ['idle', 'Idle'];
      for (const g of groups) {
        try {
          modelRef.current.motion(g);
          break;
        } catch {
          /* try next */
        }
      }
    }
  }, [isSpeaking]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      const wrapper = canvasWrapperRef.current;
      const app = appRef.current;
      const model = modelRef.current;
      if (!wrapper || !app || !model) return;

      const w = wrapper.clientWidth || 300;
      const h = wrapper.clientHeight || 280;
      app.renderer.resize(w, h);

      const fitScale =
        Math.min((w / model.width) * model.scale.x, (h / model.height) * model.scale.y) * 0.95;
      model.scale.set(fitScale);
      model.x = w / 2;
      model.y = h / 2;
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [modelLoaded]);

  // Mouse eye tracking
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const model = modelRef.current;
    const wrapper = canvasWrapperRef.current;
    if (!model || !wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    try {
      model.focus(e.clientX - rect.left, e.clientY - rect.top);
    } catch {
      /* focus not supported */
    }
  }, []);

  const applyModelUrl = useCallback(
    (url: string) => {
      const clean = url.trim();
      if (!clean) return;
      localStorage.setItem(STORAGE_KEY, clean);
      onModelChange?.(clean);
      setModelLoaded(false);
      setLoadError(null);
    },
    [onModelChange]
  );

  const handleSelectChange = useCallback(
    (value: string) => {
      if (value === CUSTOM_PREFIX) {
        setShowCustomInput(true);
        return;
      }
      setShowCustomInput(false);
      setCustomUrl('');
      applyModelUrl(value);
    },
    [applyModelUrl]
  );

  const handleCustomSubmit = useCallback(() => {
    if (customUrl.trim()) {
      applyModelUrl(customUrl.trim());
    }
  }, [customUrl, applyModelUrl]);

  return (
    <div className="live2d-panel" ref={containerRef}>
      {/* Header */}
      <div className="live2d-header">
        <span
          style={{
            fontSize: '12px',
            color: '#00f2fe',
            fontFamily: 'Orbitron',
            textTransform: 'uppercase',
            fontWeight: 'bold',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          ◆ AI ASSISTANT
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isSpeaking && (
            <span
              style={{
                fontSize: '10px',
                color: '#a855f7',
                fontFamily: 'Orbitron',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <span className="led-dot led-speaking" style={{ width: '6px', height: '6px' }}></span>
              SPEAKING
            </span>
          )}
          <select
            value={selectValue}
            onChange={(e) => handleSelectChange(e.target.value)}
            style={{
              background: '#1e293b',
              border: '1px solid rgba(0,242,254,0.3)',
              color: '#e2e8f0',
              padding: '2px 6px',
              borderRadius: '4px',
              fontSize: '10px',
              cursor: 'pointer',
              fontFamily: 'monospace',
            }}
          >
            {LIVE2D_MODELS.map((m) => (
              <option key={m.url} value={m.url}>
                {m.label}
              </option>
            ))}
            <option value={CUSTOM_PREFIX}>自定义模型...</option>
          </select>
        </div>
      </div>

      {/* Custom URL Input */}
      {showCustomInput && (
        <div
          style={{
            display: 'flex',
            gap: '4px',
            padding: '4px 0',
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomSubmit();
            }}
            placeholder="/live2d/你的模型/model.model3.json 或 https://..."
            style={{
              flex: 1,
              background: '#1e293b',
              border: '1px solid rgba(0,242,254,0.3)',
              color: '#e2e8f0',
              padding: '4px 8px',
              borderRadius: '4px',
              fontSize: '10px',
              fontFamily: 'monospace',
              outline: 'none',
            }}
          />
          <button
            onClick={handleCustomSubmit}
            style={{
              background: 'rgba(0,242,254,0.15)',
              border: '1px solid rgba(0,242,254,0.4)',
              color: '#00f2fe',
              padding: '4px 10px',
              borderRadius: '4px',
              fontSize: '10px',
              cursor: 'pointer',
              fontFamily: 'Orbitron',
              whiteSpace: 'nowrap',
            }}
          >
            加载
          </button>
        </div>
      )}

      {/* Canvas + Speech Bubble */}
      <div className="live2d-stage">
        {/* PIXI canvas mounts here - React must NOT manage children of this div */}
        <div className="live2d-canvas-wrapper" ref={canvasWrapperRef} onMouseMove={handleMouseMove} />

        {/* Overlays positioned absolutely over the canvas (siblings, not children) */}
        {loadError && (
          <div className="live2d-status-overlay live2d-status-error">
            <div style={{ fontSize: '28px', marginBottom: '8px' }}>😵</div>
            <div style={{ whiteSpace: 'pre-wrap', textAlign: 'center', padding: '0 12px' }}>
              {loadError}
            </div>
          </div>
        )}
        {!modelLoaded && !loadError && (
          <div className="live2d-status-overlay live2d-status-loading">
            <div className="live2d-loading-spinner"></div>
            <div style={{ marginTop: '8px' }}>{loadLog || '加载 Live2D 模型中...'}</div>
          </div>
        )}

        {/* Speech Bubble */}
        {bubbleText && (
          <div className="live2d-speech-bubble visible">
            <div className="live2d-bubble-content">{bubbleText}</div>
            <div className="live2d-bubble-tail"></div>
          </div>
        )}
      </div>
    </div>
  );
}
