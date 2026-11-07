export const EXIT = { PASS: 0, FAIL: 1, INCONCLUSIVE: 2, USAGE: 3 } as const;
export const exitFor = (d: 'PASS' | 'FAIL' | 'INCONCLUSIVE'): number => EXIT[d];
