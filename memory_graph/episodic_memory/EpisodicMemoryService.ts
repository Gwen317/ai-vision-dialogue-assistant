export interface MemoryCard {
  id: string;
  timestamp: Date;
  imageVector: number[] | null;
  textVector: number[];
  description: string;
  transcript: string;
}

export class EpisodicMemoryService {
  private static memories: MemoryCard[] = [];

  private static tokenize(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(token => token.length > 1);

    return new Set(tokens);
  }

  private static lexicalSimilarity(a: string, b: string): number {
    const aTokens = this.tokenize(a);
    const bTokens = this.tokenize(b);

    if (aTokens.size === 0 || bTokens.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const token of aTokens) {
      if (bTokens.has(token)) {
        intersection++;
      }
    }

    const union = new Set([...aTokens, ...bTokens]).size;
    return intersection / union;
  }

  public static async recordMemory(
    userSpeech: string,
    aiResponse: string,
    imageBase64: string | null
  ): Promise<void> {
    const combinedText = `User: ${userSpeech}\nAI: ${aiResponse}`;
    const memory: MemoryCard = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date(),
      imageVector: null,
      textVector: [],
      description: imageBase64 ? 'camera frame attached' : 'pure speech',
      transcript: combinedText
    };

    this.memories.push(memory);
    this.memories = this.memories.slice(-50);
    console.log(`Saved memory card: "${memory.description}" at ${memory.timestamp.toLocaleTimeString()}`);
  }

  public static async queryMemory(
    queryText: string,
    currentImageBase64: string | null
  ): Promise<MemoryCard | null> {
    if (this.memories.length === 0) return null;

    let bestMemory: MemoryCard | null = null;
    let highestScore = 0;

    for (const memory of this.memories) {
      let score = this.lexicalSimilarity(queryText, memory.transcript);
      if (currentImageBase64 && memory.description === 'camera frame attached') {
        score += 0.05;
      }

      if (score > highestScore) {
        highestScore = score;
        bestMemory = memory;
      }
    }

    const threshold = 0.12;
    if (bestMemory && highestScore >= threshold) {
      console.log(`Recalled memory "${bestMemory.description}" with lexical score ${highestScore.toFixed(3)}`);
      return bestMemory;
    }

    return null;
  }
}
