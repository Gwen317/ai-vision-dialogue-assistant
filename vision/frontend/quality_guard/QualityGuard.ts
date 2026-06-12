export interface QualityResult {
  passed: boolean;
  reason?: string;
  score?: number;
}

export class QualityGuard {
  /**
   * Evaluates image brightness.
   * Y = 0.299R + 0.587G + 0.114B
   */
  public static checkBrightness(imageData: ImageData): QualityResult {
    const data = imageData.data;
    let totalLuminance = 0;
    const totalPixels = imageData.width * imageData.height;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      totalLuminance += (0.299 * r + 0.587 * g + 0.114 * b);
    }

    const averageBrightness = totalLuminance / totalPixels;

    if (averageBrightness < 40) {
      return { passed: false, reason: 'The environment is too dark. Please turn on the lights.', score: averageBrightness };
    }
    if (averageBrightness > 240) {
      return { passed: false, reason: 'The environment is overexposed. Please adjust your light source.', score: averageBrightness };
    }

    return { passed: true, score: averageBrightness };
  }

  /**
   * Evaluates image blurriness using Laplacian Variance operator.
   * Approx using standard discrete Laplacian kernel convolution.
   */
  public static checkBlur(imageData: ImageData): QualityResult {
    const width = imageData.width;
    const height = imageData.height;
    const src = imageData.data;

    // Convert to greyscale
    const grey = new Float32Array(width * height);
    for (let i = 0; i < src.length; i += 4) {
      grey[i / 4] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    }

    // Laplacian Kernel:
    // [  0,  1,  0 ]
    // [  1, -4,  1 ]
    // [  0,  1,  0 ]
    const laplacian = new Float32Array(width * height);
    let sum = 0;
    let laplacianPixels = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const val = 
          grey[idx - width] + // Top
          grey[idx - 1] +     // Left
          grey[idx + 1] +     // Right
          grey[idx + width] - // Bottom
          4 * grey[idx];
        
        laplacian[idx] = val;
        sum += val;
        laplacianPixels++;
      }
    }

    const mean = sum / laplacianPixels;

    // Variance calculation
    let varianceSum = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        const diff = laplacian[idx] - mean;
        varianceSum += diff * diff;
      }
    }

    const variance = varianceSum / laplacianPixels;
    const BLUR_THRESHOLD = 12.0;

    if (variance < BLUR_THRESHOLD) {
      return { passed: false, reason: 'The frame is too blurry. Please hold the camera steady.', score: variance };
    }

    return { passed: true, score: variance };
  }
}
