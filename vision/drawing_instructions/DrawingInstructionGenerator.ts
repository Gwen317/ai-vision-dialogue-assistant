export interface DrawInstruction {
  type: string;
  params: string[];
}

export class DrawingInstructionGenerator {
  /**
   * Encodes a geometric drawing into LLM inline tags so client-side CanvasSyncRenderer can draw it.
   * Format: [[draw:type:param1:param2...]]
   */
  public static clear(): string {
    return '[[draw:clear]]';
  }

  public static circle(cx: number, cy: number, r: number, color?: string): string {
    return `[[draw:circle:${cx}:${cy}:${r}:${color || '#00f2fe'}]]`;
  }

  public static line(x1: number, y1: number, x2: number, y2: number, color?: string, strokeWidth?: number): string {
    return `[[draw:line:${x1}:${y1}:${x2}:${y2}:${color || '#00f2fe'}:${strokeWidth || 2}]]`;
  }

  public static rect(x1: number, y1: number, x2: number, y2: number, color?: string): string {
    return `[[draw:rect:${x1}:${y1}:${x2}:${y2}:${color || '#00f2fe'}]]`;
  }

  public static text(x1: number, y1: number, content: string, color?: string): string {
    // Sanitize colons or brackets in text content
    const safeContent = content.replace(/[:[\]]/g, '');
    return `[[draw:text:${x1}:${y1}:${safeContent}:${color || '#00f2fe'}]]`;
  }
}
