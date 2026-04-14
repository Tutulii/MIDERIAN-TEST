import { execute } from './sigmoidDecayCollateralCalculator';

describe('sigmoidDecayCollateralCalculator', () => {
  it('should return the initial collateral on day 0', () => {
    expect(execute(500, 30, 0)).toBeCloseTo(250, 1);
  });

  it('should return approximately half the collateral on the midpoint day', () => {
    expect(execute(500, 30, 15)).toBeCloseTo(250, 1);
  });

  it('should return a value close to the initial collateral on the last day', () => {
    expect(execute(500, 30, 30)).toBeCloseTo(500, 1);
  });

  it('should throw an error if current day is out of range', () => {
    expect(() => execute(500, 30, 31)).toThrow('Current day must be within the range of 0 to totalDays.');
    expect(() => execute(500, 30, -1)).toThrow('Current day must be within the range of 0 to totalDays.');
  });
});