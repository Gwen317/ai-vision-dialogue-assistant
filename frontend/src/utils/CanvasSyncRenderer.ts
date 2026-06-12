export interface DrawCommand {
  type: 'line' | 'circle' | 'rect' | 'text' | 'clear';
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  r?: number;
  text?: string;
  color?: string;
  strokeWidth?: number;
}

export class CanvasSyncRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private drawingQueue: { timestamp: number; command: DrawCommand }[] = [];
  private isDrawing: boolean = false;

  constructor(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
      this.clearCanvas();
    }
  }

  public clearCanvas() {
    if (!this.ctx || !this.canvas) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Draw sci-fi style grid background
    this.ctx.strokeStyle = 'rgba(0, 242, 254, 0.05)';
    this.ctx.lineWidth = 1;
    const step = 20;
    
    for (let x = 0; x < this.canvas.width; x += step) {
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.canvas.height);
      this.ctx.stroke();
    }
    
    for (let y = 0; y < this.canvas.height; y += step) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.canvas.width, y);
      this.ctx.stroke();
    }
  }

  // Parses instructions returned by LLM (e.g. "CMD: [circle, 150, 150, 50]")
  public parseInstructions(text: string): { triggerCharIndex: number; command: DrawCommand }[] {
    const commands: { triggerCharIndex: number; command: DrawCommand }[] = [];
    
    // Regex to find draw instructions like [[draw:type:x1:y1:x2:y2...]] in text
    // Example: "Next, we draw a circle [[draw:circle:150:150:40]]"
    const regex = /\[\[draw:([^\]]+)\]\]/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      const parts = match[1].split(':');
      const type = parts[0] as any;
      const index = match.index; // Index in the text where this command is triggered
      
      let command: DrawCommand | null = null;
      
      if (type === 'clear') {
        command = { type: 'clear' };
      } else if (type === 'circle') {
        command = {
          type: 'circle',
          cx: parseInt(parts[1]),
          cy: parseInt(parts[2]),
          r: parseInt(parts[3]),
          color: parts[4] || '#00f2fe'
        };
      } else if (type === 'line') {
        command = {
          type: 'line',
          x1: parseInt(parts[1]),
          y1: parseInt(parts[2]),
          x2: parseInt(parts[3]),
          y2: parseInt(parts[4]),
          color: parts[5] || '#00f2fe',
          strokeWidth: parseInt(parts[6]) || 2
        };
      } else if (type === 'rect') {
        command = {
          type: 'rect',
          x1: parseInt(parts[1]),
          y1: parseInt(parts[2]),
          x2: parseInt(parts[3]),
          y2: parseInt(parts[4]),
          color: parts[5] || '#00f2fe'
        };
      } else if (type === 'text') {
        command = {
          type: 'text',
          x1: parseInt(parts[1]),
          y1: parseInt(parts[2]),
          text: parts[3],
          color: parts[4] || '#00f2fe'
        };
      }
      
      if (command) {
        commands.push({ triggerCharIndex: index, command });
      }
    }
    
    return commands;
  }

  public executeCommand(cmd: DrawCommand) {
    if (!this.ctx || !this.canvas) return;

    this.ctx.save();
    this.ctx.strokeStyle = cmd.color || '#00f2fe';
    this.ctx.fillStyle = cmd.color || '#00f2fe';
    this.ctx.lineWidth = cmd.strokeWidth || 2;
    this.ctx.shadowBlur = 10;
    this.ctx.shadowColor = cmd.color || '#00f2fe';

    switch (cmd.type) {
      case 'clear':
        this.clearCanvas();
        break;
      case 'circle':
        if (cmd.cx !== undefined && cmd.cy !== undefined && cmd.r !== undefined) {
          this.ctx.beginPath();
          this.ctx.arc(cmd.cx, cmd.cy, cmd.r, 0, 2 * Math.PI);
          this.ctx.stroke();
        }
        break;
      case 'line':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x2 !== undefined && cmd.y2 !== undefined) {
          this.ctx.beginPath();
          this.ctx.moveTo(cmd.x1, cmd.y1);
          
          // Animate drawing line
          let progress = 0;
          const drawFrame = () => {
            if (!this.ctx || !this.canvas) return;
            progress += 0.05;
            if (progress > 1) progress = 1;
            
            const curX = cmd.x1! + (cmd.x2! - cmd.x1!) * progress;
            const curY = cmd.y1! + (cmd.y2! - cmd.y1!) * progress;
            
            this.ctx.beginPath();
            this.ctx.moveTo(cmd.x1!, cmd.y1!);
            this.ctx.lineTo(curX, curY);
            this.ctx.stroke();
            
            if (progress < 1) {
              requestAnimationFrame(drawFrame);
            }
          };
          drawFrame();
        }
        break;
      case 'rect':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.x2 !== undefined && cmd.y2 !== undefined) {
          this.ctx.strokeRect(cmd.x1, cmd.y1, cmd.x2 - cmd.x1, cmd.y2 - cmd.y1);
        }
        break;
      case 'text':
        if (cmd.x1 !== undefined && cmd.y1 !== undefined && cmd.text !== undefined) {
          this.ctx.font = '14px Orbitron, sans-serif';
          this.ctx.shadowBlur = 5;
          this.ctx.fillText(cmd.text, cmd.x1, cmd.y1);
        }
        break;
    }
    
    this.ctx.restore();
  }
}
