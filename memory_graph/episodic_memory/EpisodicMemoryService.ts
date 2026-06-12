import { GoogleGenerativeAI } from '@google/generative-ai';

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
  private static genAI: GoogleGenerativeAI | null = null;

  private static getGenAI() {
    if (!this.genAI) {
      this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    }
    return this.genAI;
  }

  private static cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  public static async recordMemory(
    userSpeech: string,
    aiResponse: string,
    imageBase64: string | null
  ): Promise<void> {
    try {
      const genAI = this.getGenAI();
      const combinedText = `User: ${userSpeech}\nAI: ${aiResponse}`;

      // 1. Get Text Embedding
      const textModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
      const textEmbedResult = await textModel.embedContent(combinedText);
      const textVector = textEmbedResult.embedding.values;

      let imageVector: number[] | null = null;
      let description = '';

      // 2. Get Multimodal Image Embedding & Description
      if (imageBase64) {
        try {
          const multimodalModel = genAI.getGenerativeModel({ model: 'multimodal-embedding-001' });
          const imgPart = { inlineData: { data: imageBase64, mimeType: 'image/jpeg' } };
          const imgEmbedResult = await multimodalModel.embedContent({
            content: { parts: [imgPart] }
          });
          imageVector = imgEmbedResult.embedding.values;

          // Background simple description
          const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
          const descResult = await visionModel.generateContent([
            imgPart,
            'Describe the main object shown in this image in exactly one simple sentence. Focus on its appearance, color, and name.'
          ]);
          description = descResult.response.text().trim();
        } catch (visionErr) {
          console.error('Error generating image embedding/description:', visionErr);
        }
      }

      const memory: MemoryCard = {
        id: Math.random().toString(36).substring(2, 9),
        timestamp: new Date(),
        imageVector,
        textVector,
        description,
        transcript: combinedText
      };

      this.memories.push(memory);
      console.log(`Saved memory card: "${description || 'pure speech'}" at ${memory.timestamp.toLocaleTimeString()}`);
    } catch (err) {
      console.error('Failed to record memory:', err);
    }
  }

  public static async queryMemory(
    queryText: string,
    currentImageBase64: string | null
  ): Promise<MemoryCard | null> {
    if (this.memories.length === 0) return null;

    try {
      const genAI = this.getGenAI();

      // 1. Get Query Text Embedding
      const textModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
      const queryTextEmbed = await textModel.embedContent(queryText);
      const queryTextVector = queryTextEmbed.embedding.values;

      // 2. Get Query Image Embedding
      let queryImageVector: number[] | null = null;
      if (currentImageBase64) {
        try {
          const multimodalModel = genAI.getGenerativeModel({ model: 'multimodal-embedding-001' });
          const imgPart = { inlineData: { data: currentImageBase64, mimeType: 'image/jpeg' } };
          const queryImgEmbed = await multimodalModel.embedContent({
            content: { parts: [imgPart] }
          });
          queryImageVector = queryImgEmbed.embedding.values;
        } catch (imgErr) {
          console.error('Error getting query image embedding:', imgErr);
        }
      }

      let bestMemory: MemoryCard | null = null;
      let highestScore = -1;

      // 3. Scan and calculate similarity
      for (const memory of this.memories) {
        const textScore = this.cosineSimilarity(queryTextVector, memory.textVector);
        let finalScore = textScore;

        if (queryImageVector && memory.imageVector) {
          const imageScore = this.cosineSimilarity(queryImageVector, memory.imageVector);
          // Hybrid weight: 40% text, 60% visual
          finalScore = textScore * 0.4 + imageScore * 0.6;
        } else if (!queryImageVector && memory.imageVector) {
          finalScore = textScore * 0.8;
        }

        if (finalScore > highestScore) {
          highestScore = finalScore;
          bestMemory = memory;
        }
      }

      const THRESHOLD = 0.70;
      if (bestMemory && highestScore >= THRESHOLD) {
        console.log(`Recalled memory "${bestMemory.description || 'pure speech'}" with score ${highestScore.toFixed(3)}`);
        return bestMemory;
      }
      return null;
    } catch (err) {
      console.error('Error querying episodic memory:', err);
      return null;
    }
  }
}
