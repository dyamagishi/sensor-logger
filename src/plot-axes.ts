import type uPlot from 'uplot';

export type GraphMetric = 'temperature' | 'humidity' | 'co2' | 'kelvin';
const minimumSpan = {temperature: 2, humidity: 10, co2: 200, kelvin: 500};
const fallback: Record<GraphMetric, [number, number]> = {
  temperature: [0, 40], humidity: [0, 100], co2: [0, 2000], kelvin: [2000, 6500],
};
/** Keep small fluctuations in proportion, with readable bounds and room at both ends. */
export function metricRange(metric: GraphMetric, min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return fallback[metric];
  const span = Math.max(max - min, minimumSpan[metric]);
  const center = (min + max) / 2;
  const rawStep = span / 4;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map(n => n * power).find(n => n >= rawStep)!;
  let low = Math.floor((center - span * .6) / step) * step;
  let high = Math.ceil((center + span * .6) / step) * step;
  if (metric !== 'temperature') low = Math.max(0, low);
  if (metric === 'humidity') high = Math.min(100, high);
  // Include every observed value, even outside the usual physical range.
  return [Math.min(low, min), Math.max(high, max)];
}

export function timeLabels(ticks: number[], span: number): string[] {
  let previousDay = '';
  return ticks.map(ts => {
    const date = new Date(ts * 1000);
    const day = date.toLocaleDateString('ja-JP', {timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', ...(span >= 180 * 86400 ? {year: 'numeric'} : {})});
    const time = date.toLocaleTimeString('ja-JP', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'});
    const label = span <= 2 * 86400 ? time + (day !== previousDay ? '\n' + day : '')
      : span <= 14 * 86400 ? (day !== previousDay ? day + '\n' + time : time) : day;
    previousDay = day;
    return label;
  });
}

export function timeAxis(): uPlot.Axis {
  return {values: (u, ticks) => timeLabels(ticks, u.scales.x.max! - u.scales.x.min!),
    space: 90, size: 54, stroke: '#93a5ad', grid: {stroke: '#26363f'}, font: '12px sans-serif'};
}
export function valueAxis(unit: string): uPlot.Axis {
  return {values: (_u, ticks) => ticks.map(n => n.toLocaleString('ja-JP', {maximumFractionDigits: 2}) + ' ' + unit),
    space: 36, size: unit === 'ppm' ? 86 : 72, stroke: '#93a5ad', grid: {stroke: '#26363f'}, font: '12px sans-serif'};
}
