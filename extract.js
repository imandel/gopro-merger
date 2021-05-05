const gpmfExtract = require('gpmf-extract');
const goproTelemetry = require(`gopro-telemetry`);
const fs = require('fs');
const glob = require('glob-promise')
const filePath = '/mnt/nissan_temp/';
const path = require('path');

async function processVid(vidPath){
  const outDir = path.join(path.dirname(vidPath), 'vid_meta')
  await fs.promises.access(outDir)
    .catch(async (e) => {
   if (e.code === 'ENOENT') {
    fs.mkdirSync(outDir)
    }
    else {
      console.log(e)
    }
  })
    try {
  const fileData = await gpmfExtract(bufferAppender(vidPath, 10 * 1024 * 1024))
  // console.log(fileData)
  const telemetry = await goproTelemetry(fileData)
  const outfile = path.join(outDir, path.basename(vidPath, path.extname(vidPath))+'.json')
  await fs.promises.writeFile(outfile, JSON.stringify(telemetry))
}
catch(err){
  console.log(err, vidPath)
}
}



(async () => {
  const files = await glob(filePath +'**/*.MP4')
  for (const file of files){
    await processVid(file)
  }
})();


function bufferAppender(path, chunkSize) {
  return function (mp4boxFile) {
    var stream = fs.createReadStream(path, { highWaterMark: chunkSize });
    var bytesRead = 0;
    stream.on('end', () => {
      mp4boxFile.flush();
    });
    stream.on('data', chunk => {
      var arrayBuffer = new Uint8Array(chunk).buffer;
      arrayBuffer.fileStart = bytesRead;
      mp4boxFile.appendBuffer(arrayBuffer);
      bytesRead += chunk.length;
    });
    stream.resume();
  };
}