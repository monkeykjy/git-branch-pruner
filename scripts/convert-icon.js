const sharp = require('sharp');
const path = require('path');

const svgPath = path.join(__dirname, '../media/icon.svg');
const pngPath = path.join(__dirname, '../media/icon.png');

sharp(svgPath)
  .resize(128, 128) // VS Code 推荐的图标尺寸
  .png()
  .toFile(pngPath)
  .then(() => console.log('PNG icon generated successfully!'))
  .catch(err => console.error('Error generating PNG:', err));