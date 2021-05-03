const gpmfExtract = require('gpmf-extract');
const goproTelemetry = require(`gopro-telemetry`);
const fs = require('fs');
const glob = require('glob-promise')
const filePath = '/home/farlab/nissan/data/p5/rear_left/';

const data = []

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

async function run(){
	const files = await glob(filePath +'*.MP4')//, {}, async (err, files) => {
    for (const file of files) {
			console.log(`processing ${file}`)
				const fileData = await gpmfExtract(bufferAppender(file, 10 * 1024 * 1024))
				data.push(fileData)
			}
  await console.log(data)
	const telemetry = await goproTelemetry(data[0])
	await fs.promises.writeFile('output.json', JSON.stringify(telemetry))
	console.log('saved!')


}

run()