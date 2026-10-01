import { Rectangle, Sprite, Texture } from 'pixi.js';
import { getFigureBaseX, type IFigurePosition } from '@/Core/Modules/stage/stageInterface';

/**
 * Adapter for Live2D's reference bounds: [x0, y0, width + x1, height + y1].
 * Only measurement changes; Sprite's vertices/UVs still draw the entire canvas.
 */
export class GltfCharacterSprite extends Sprite {
  public constructor(texture: Texture, private readonly referenceOffsets: readonly number[] = [0, 0, 0, 0]) {
    super(texture);
  }

  public getBaseX(position: IFigurePosition, stageWidth: number): number {
    return getFigureBaseX(position, stageWidth, this.width);
  }

  public override getLocalBounds(rect = new Rectangle()): Rectangle {
    if (this.referenceOffsets.every((value) => value === 0)) return super.getLocalBounds(rect);
    const { width, height } = this.texture.orig;
    const [x0, y0, x1, y1] = this.referenceOffsets;
    const right = width + x1;
    const bottom = height + y1;
    // Live2D represents anchor as pivot; Sprite represents it in its vertices.
    // Subtracting the canvas anchor here gives the same final local rectangle.
    rect.x = Math.min(x0, right) - this.anchor.x * width;
    rect.y = Math.min(y0, bottom) - this.anchor.y * height;
    rect.width = Math.abs(right - x0);
    rect.height = Math.abs(bottom - y0);
    return rect;
  }

  protected override _calculateBounds(): void {
    if (this.referenceOffsets.every((value) => value === 0)) {
      super._calculateBounds();
      return;
    }
    const rect = this.getLocalBounds();
    this._bounds.addFrame(this.transform, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  }

  public override get width(): number {
    return Math.abs(this.scale.x) * this.getLocalBounds().width;
  }
  public override set width(value: number) {
    const localWidth = this.getLocalBounds().width;
    this.scale.x = localWidth ? ((Math.sign(this.scale.x) || 1) * value) / localWidth : 1;
  }
  public override get height(): number {
    return Math.abs(this.scale.y) * this.getLocalBounds().height;
  }
  public override set height(value: number) {
    const localHeight = this.getLocalBounds().height;
    this.scale.y = localHeight ? ((Math.sign(this.scale.y) || 1) * value) / localHeight : 1;
  }
}
