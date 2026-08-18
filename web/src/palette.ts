/**
 * Colour scheme for noise isophones.
 *
 * This is the "Coloring Noise" scheme (Beate Tomio, 2016), one of the styles
 * shipped with NoiseModelling. It was chosen over the legacy national standards
 * on measured grounds rather than taste:
 *
 * - DIN 18005-2 / UNI 9884 has three lightness inversions, including a +0.50
 *   OKLab jump straight from dark green into bright yellow, and its two loudest
 *   bands (75-80 and >80) sit at ΔE 7.7 in *normal* vision — the levels a reader
 *   most needs to tell apart are the ones it renders nearly identically.
 * - This scheme darkens monotonically across every band from 55 dB upward, which
 *   is the decision-relevant range (the WHO road-traffic guideline is 53 dB Lden).
 *   Its weakest adjacent pair sits at the quiet end, where confusion costs least.
 *
 * Its remaining weakness is low contrast against a light basemap in the pale
 * quiet bands, so every polygon carries a stroke and the legend labels each band
 * in text — level is never communicated by colour alone.
 */
export interface Band {
  /** ISOLVL value as produced by Create_Isosurface. */
  level: number;
  label: string;
  color: string;
}

export const BANDS: Band[] = [
  { level: 0, label: 'до 35', color: '#82a7ac' },
  { level: 1, label: '35–40', color: '#a0bbbf' },
  { level: 2, label: '40–45', color: '#b8d6d1' },
  { level: 3, label: '45–50', color: '#cfe4cc' },
  { level: 4, label: '50–55', color: '#e3f2bf' },
  { level: 5, label: '55–60', color: '#f4c683' },
  { level: 6, label: '60–65', color: '#e87d4d' },
  { level: 7, label: '65–70', color: '#cd463f' },
  { level: 8, label: '70–75', color: '#a11a4d' },
  { level: 9, label: '75–80', color: '#75095d' },
  { level: 10, label: 'выше 80', color: '#430a4a' },
];

const byLevel = new Map(BANDS.map((b) => [b.level, b]));

export const bandFor = (level: number): Band | undefined => byLevel.get(level);
