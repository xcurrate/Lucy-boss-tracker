const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { readRewards, shutdownOCR } = require('../src/services/rewardOCR');

const DIGITS = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','10000','11110','00001','00001','11110'],
  '6': ['01110','10000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00001','01110']
};

function makeLucyRewardFixture() {
  const image = new PNG({ width: 1536, height: 208 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 39; image.data[i + 1] = 43; image.data[i + 2] = 52; image.data[i + 3] = 255;
  }
  const regions = [
    [0.08, 0.245, '99'],
    [0.32, 0.493, '4'],
    [0.57, 0.738, '6'],
    [0.82, 0.984, '10174']
  ];
  const scale = 7;
  const yStart = 62;
  for (const [left, right, value] of regions) {
    const textWidth = value.length * 5 * scale + (value.length - 1) * scale;
    let xStart = Math.floor(((left + right) / 2) * image.width - textWidth / 2);
    for (const char of value) {
      const glyph = DIGITS[char];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] !== '1') continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const x = xStart + col * scale + dx;
              const y = yStart + row * scale + dy;
              const index = (y * image.width + x) * 4;
              image.data[index] = 255;
              image.data[index + 1] = 255;
              image.data[index + 2] = 255;
              image.data[index + 3] = 255;
            }
          }
        }
      }
      xStart += 6 * scale;
    }
  }
  return PNG.sync.write(image);
}

after(async () => {
  await shutdownOCR();
});

describe('reward OCR integration', () => {
  it('reads all four reward values from a Lucy reward-card layout fixture', async () => {
    const rewards = await readRewards(makeLucyRewardFixture());
    assert.deepEqual(rewards, {
      weapon_shards: 99,
      weapon_crate: 4,
      fabled_lootbox: 6,
      experience: 10174
    });
  });
});
