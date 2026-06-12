export type AppState = 'IDLE' | 'LISTENING' | 'THINKING' | 'SPEAKING';

export class FsmController {
  private currentState: AppState = 'IDLE';
  private stateListeners: ((state: AppState) => void)[] = [];

  constructor() {
    this.currentState = 'IDLE';
  }

  public registerStateListener(listener: (state: AppState) => void) {
    this.stateListeners.push(listener);
    // Emit current state immediately
    listener(this.currentState);
  }

  public transitionTo(newState: AppState) {
    if (this.currentState === newState) return;
    
    console.log(`FSM transition: ${this.currentState} -> ${newState}`);
    this.currentState = newState;
    
    // Notify all listeners
    for (const listener of this.stateListeners) {
      listener(newState);
    }
  }

  public getCurrentState(): AppState {
    return this.currentState;
  }
}
