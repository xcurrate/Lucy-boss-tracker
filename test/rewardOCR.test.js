const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const { readRewards, shutdownOCR } = require('../src/services/rewardOCR');

const FONT = {
  '0': ['111','101','101','101','111'],
  '1': ['010','110','010','010','111'],
  '2': ['111','001','111','100','111'],
  '3': ['111','001','111','001','111'],
  '4': ['101','101','111','001','001'],
  '5': ['111','100','111','001','111'],
  '6': ['111','100','111','101','111'],
  '7': ['111','001','001','001','001'],
  '8': ['111','101','111','101','111'],
  '9': ['111','101','111','001','111']
};

function drawNumber(image, centerX, centerY, text) {
  const scale = 8;
  const glyphWidth = 3 * scale;
  const gap = scale;
  const totalWidth = text.length * glyphWidth + (text.length - 1) * gap;
  const startX = Math.round(centerX - totalWidth / 2);
  const startY = Math.round(centerY - (5 * scale) / 2);
  for (let index = 0; index < text.length; index++) {
    const rows = FONT[text[index]];
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        if (rows[y][x] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = startX + index * (glyphWidth + gap) + x * scale + sx;
            const py = startY + y * scale + sy;
            const offset = (py * image.width + px) * 4;
            image.data[offset] = 255;
            image.data[offset + 1] = 255;
            image.data[offset + 2] = 255;
            image.data[offset + 3] = 255;
          }
        }
      }
    }
  }
}

function makeSyntheticRewardImage() {
  const image = new PNG({ width: 1200, height: 500 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = 30;
    image.data[i + 1] = 32;
    image.data[i + 2] = 38;
    image.data[i + 3] = 255;
  }
  const centers = [0.1725, 0.4215, 0.667, 0.913].map(x => x * image.width);
  ['123', '45', '678', '90'].forEach((value, index) => drawNumber(image, centers[index], image.height * 0.42, value));
  return PNG.sync.write(image);
}

after(async () => {
  await shutdownOCR();
});

describe('reward OCR integration', () => {
  it('reads all four numeric reward regions from a controlled PNG fixture', async () => {
    const rewards = await readRewards(makeSyntheticRewardImage());
    assert.deepEqual(rewards, {
      weapon_shards: 123,
      weapon_crate: 45,
      fabled_lootbox: 678,
      experience: 90
    });
  });
});
