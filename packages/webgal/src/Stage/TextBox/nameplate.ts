import { IStageState, figureStateKeyByPosition, IFigurePosition } from '@/Core/Modules/stage/stageInterface';
import { WebgalTemplate } from '@/types/template';

const keywordPatterns = new Map<string, RegExp>();

function matchesKeyword(path: string, keyword: string): boolean {
  const normalized = keyword.toLowerCase();
  if (!normalized.includes('?')) return path.includes(normalized);
  let pattern = keywordPatterns.get(normalized);
  if (!pattern) {
    pattern = new RegExp(normalized.replace(/[.*+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '[^/]'));
    keywordPatterns.set(normalized, pattern);
  }
  return pattern.test(path);
}

export function resolveNameplate(stage: IStageState, rules: WebgalTemplate['nameplate-rules']): string | undefined {
  if (!stage.showName || !stage.dialogueFigure || !Array.isArray(rules)) return undefined;
  const target = stage.dialogueFigure;
  const freeFigure = stage.freeFigure.find((figure) => figure.key === target);
  const position = target.startsWith('fig-') ? target.slice(4) : '';
  const stateKey = Object.prototype.hasOwnProperty.call(figureStateKeyByPosition, position)
    ? figureStateKeyByPosition[position as IFigurePosition]
    : undefined;
  const path = freeFigure?.name ?? (stateKey ? stage[stateKey] : '');
  if (!path) return undefined;
  let normalized = path.replace(/\\/g, '/');
  const bodyStart = normalized.search(/config\.json\+/i);
  if (bodyStart >= 0) normalized = normalized.slice(0, bodyStart + 'config.json'.length);
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    /* Keep literal paths with percent signs. */
  }
  normalized = normalized.toLowerCase();
  return rules.find(
    (rule) =>
      rule &&
      typeof rule.style === 'string' &&
      /^[a-zA-Z0-9_-]+$/.test(rule.style) &&
      Array.isArray(rule.keywords) &&
      rule.keywords.some(
        (keyword) => typeof keyword === 'string' && keyword.length > 0 && matchesKeyword(normalized, keyword),
      ),
  )?.style;
}
