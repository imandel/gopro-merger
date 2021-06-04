// PROGRESS | GENERAL APPROACH
// DONE       1. For each camera: find the different files
// DONE          a. Order the files
// DONE          b. Get the start time (unix time from the gpmf-extract object 'start') for each and the length
//                  of the video
// DONE          e. Find the difference between end time (from the duration/start time) and the next
//                  start time for each subsequent video
// DEBUG         f. Loop through the videos and append them with blank time when there is a gap between
//                  end time and start time of the next video
//                  (NOTE: should loop through each GP video for each GOPR and append before appending
//                  data from the next GOPR vclip)
// DEBUG         g. Save this master video
// DEBUG         h. Save the telemetry data for this camera
// DEBUG      2. Find the earliest start time for each camera
// DEBUG         a. For any videos with start times later than the earliest start time, append
//                  blank time at the beginning of the processed clip to align them
// DEBUG         b. Do the same with the end of the video
// DEBUG      3. Use ffmpeg to put the videos side-by-side for all videos for an individual
//               participant
// DEBUG      4. Save this video to the main p[num] folder

// PROGRESS | VARIOUS TO-DOs
// DONE       1. Remove slices to allow run over all cameras/videos
// OPEN       2. Change the filePath to be a command line argment where the
//               user can input the path to the participant
// OPEN       3. Change the output files to save to a command line argument path
//               rather than this directory
// OPEN       4. Reduce the output file sizes (give a variety of resolutions?)

// PROGRESS | CURRENT BUGS
// DEBUGGING  1. Concat is creating only audio
// DEBUGGING  2. Weird async stuff is leading it to think the file isn't available
// DEBUGGING  3. There's something strange going on with the end_diff for a camera (from latest_end)

// Import packages
const gpmfExtract = require('gpmf-extract');
// https://github.com/JuanIrache/gpmf-extract
const goproTelemetry = require('gopro-telemetry'); // https://github.com/JuanIrache/gopro-telemetry
const fs = require('fs');
const glob = require('glob-promise');
const ffmpeg = require('fluent-ffmpeg'); // https://www.npmjs.com/package/fluent-ffmpeg
const spawn = require('child_process');
const { DateTime } = require('luxon');
const path = require('path');

// Handle bug in gpmf-extract for large video files
// Read more about this here: https://github.com/JuanIrache/gpmf-extract
function bufferAppender(path, chunkSize) {
    return function (mp4boxFile) {
      const stream = fs.createReadStream(path, { highWaterMark: chunkSize });
      let bytesRead = 0;
      stream.on('end', () => {
        mp4boxFile.flush();
      });
      stream.on('data', (chunk) => {
        const arrayBuffer = new Uint8Array(chunk).buffer;
        arrayBuffer.fileStart = bytesRead;
        mp4boxFile.appendBuffer(arrayBuffer);
        bytesRead += chunk.length;
      });
      stream.resume();
    };
  }

// borrowed from https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
function onlyUnique(value, index, self) {
    return self.indexOf(value) === index;
  }
  
  async function adjustTimestamps(data) {
    const startIndex = data.map((i) => i.value[0]).findIndex((lng) => lng > 0);
    const startTime = DateTime.fromISO(data[startIndex].date).minus(data[startIndex].cts);
    const adjusted = data.map((sample) => {
      if (sample.value[0] > 0) { return sample; }
  
      sample.date = startTime.plus(sample.cts).toUTC().toString();
      return sample;
    });
    return adjusted;
  }

async function processVid(vidPath) {
    try {
        const fileData = await gpmfExtract(bufferAppender(vidPath, 10 * 1024 * 1024));
        const telemetry = await goproTelemetry(fileData);
        // this heuristic isn't perfect and might want to be refined
        telemetry['1'].streams.GPS5.samples = await adjustTimestamps(telemetry['1'].streams.GPS5.samples);
        console.log(telemetry['1'].streams.GPS5.samples[0]['date']);
        return Math.floor(new Date(telemetry['1'].streams.GPS5.samples[0]['date']).getTime()/1000);
    } catch (err) {
        console.log(err, vidPath);
    }
}

var fileOrder = {};

// Get all of the files in the filepath with `GOPR` in the name and process each
async function run(filePath) {
  // Each file is formatted as GOPR[ID].mp4 for the first chunk in a video sequence
  // subsequent chunks in the same video are formatted as GP[ind][ID].mp4
  const files = await glob(`${filePath}*/*.MP4`);
  const pathLen = filePath.split('/').length;
  let fileData;

  // Make it easier to break up the data by organizing by camera
  const cameras = files.map((val) => val.split('/')[pathLen - 1].split('/')[0]);
  const uniqueCameras = cameras.filter(onlyUnique);
  console.log(`Cameras: ${uniqueCameras}`);
  for (const cam of uniqueCameras) {
    fileOrder[cam] = [];

    // Pull the relevant "starter" files for that camera and sort them
    const goprFiles = await glob(`${filePath + cam}/GOPR*.MP4`);
    goprFiles.sort();

    for (const gopr of goprFiles) {
      fileOrder[cam].push(gopr);

      // Pull the secondary files for each recording, sort, and add to the ordering
      const fileID = gopr.split('GOPR')[1];
      const gpFiles = await glob(`${filePath + cam}/GP*${fileID}`);
      gpFiles.sort();

      for (const gp of gpFiles) {
        fileOrder[cam].push(gp);
      }
    }
  }

  let earliest_start = Infinity;
  let latest_end = 0;
  const data = {};

  for (const camera of uniqueCameras) {
    var mergeFiles = [];
    let prevEnd;

    data[camera] = {};

    for (const [idx, file] of fileOrder[camera].entries()) {
      console.log(`${camera}...processing ${idx} of ${fileOrder[camera].length}: ${file}`);

      // Get the gpmf-extract binary object for this file (adjusted with bufferAppender)
      // Add the gpmf-extract binary data to the data object for analysis
      try {
        fileData = await gpmfExtract(bufferAppender(file, 10 * 1024 * 1024));
      } catch (error) {
        console.log(error);
        break;
      }

      // Add the start time, duration, and geo binary for this file
      data[camera][file] = {};
      data[camera][file].results = fileData;
      data[camera][file].start_time = await processVid(file); //new Date(fileData.timing.start).getTime() / 1000;
      data[camera][file].duration = fileData.timing.videoDuration;

      // Get difference in time with the previous file and add a buffer video if necessary
      if (idx == 0) {
        var cameraStart = data[camera][file].start_time;
        var runningDur = data[camera][file].duration;
        prevEnd = data[camera][file].start_time + data[camera][file].duration;
        mergeFiles.push(file);
      } else {
        const timeDiff = Math.max((data[camera][file].start_time - prevEnd) / 1000, 0.0);
        console.log('timeDiff');
        console.log(timeDiff);
        var hours = Math.floor(timeDiff / 3600);
        var minutes = Math.floor((timeDiff - (hours * 3600)) / 60);
        var seconds = Math.floor(timeDiff - (minutes * 60) - (hours * 3600));
        var milliseconds = Math.floor((timeDiff % 1) * 1000);
        console.log(`-t ${hours}:${minutes}:${seconds}.${milliseconds}`);
        const blankFile = `./${idx}_blank.mp4`;
        await new Promise((resolve, reject) => {ffmpeg('color=size=1920x1080:rate=29.97:color=black').inputFormat('lavfi').input('anullsrc=channel_layout=stereo:sample_rate=48000').inputFormat('lavfi')
          .outputOptions([`-t ${hours}:${minutes}:${seconds}.${milliseconds}`])
          .on('error', function(err) {
            reject(err);
          })
          .on('end', function(){
            console.log('finished running blank between same camera videos');
            resolve();
          })
          .save(blankFile)
          .run()});
        mergeFiles.push(blankFile);
        mergeFiles.push(file);

        runningDur = runningDur + timeDiff + data[camera][file].duration;
      }
    }

    // Merge the files together after writing the file array to a txt file
    // Adapted from https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/496
    var txtFile = './merge_array.txt';
    var fileNames = '';
    mergeFiles.forEach((fileName, index) => {
      fileNames = `${fileNames}file ` + `'${fileName}'\n`;
    });
    console.log(mergeFiles);
    await fs.writeFileSync(txtFile, fileNames);
    try {
    await new Promise((resolve, reject) => {ffmpeg().input(txtFile).inputOptions(['-f concat', '-safe 0']).outputOptions('-c copy')
      .on('error', function(err){
        reject(err);
      })
      .on('end', function(){
        console.log('finished running merge for camera');
        resolve();
      })
      .save(`${camera}_concat.mp4`).run()});
    } catch (err) {
      console.log(err);
    }

    // Save the concat file info for analysis across cameras
    data[camera].concat_start = cameraStart;
    data[camera].concat_duration = runningDur;

    // Find the earliest start time
    earliest_start = Math.min(earliest_start, data[camera].concat_start);
    latest_end = Math.max(latest_end, data[camera].concat_start + data[camera].concat_duration);

    // Wait for the data object to be populated and logged
    await console.log(data);

    console.log(earliest_start);
    console.log(latest_end);

    // Extract the telemetry data from the first value in the data array
    // const telemetry = await goproTelemetry(data['Rear_Right/'][fileOrder['Rear_Right'][0]]['results'])
    // console.log(JSON.stringify(telemetry))

    // Save the data to an output file
    // await fs.promises.writeFile('output_sam.json', JSON.stringify(telemetry))
    // console.log('saved!')
  }

  var finalVideos = [];
  for (const camera of uniqueCameras) {
    var mergeFiles = [];
    data[camera].start_diff = (data[camera].concat_start - earliest_start) / 1000;
    data[camera].end_diff = (latest_end - (data[camera].concat_duration + data[camera].concat_start)) / 1000;

    console.log(data[camera].start_diff);
    console.log(data[camera].end_diff);

    if (data[camera].start_diff != 0.0) {
      var timeDiff = data[camera].start_diff;
      var hours = Math.floor(timeDiff / 3600);
      var minutes = Math.floor((timeDiff - (hours * 3600)) / 60);
      var seconds = Math.floor(timeDiff - (minutes * 60) - (hours * 3600));
      var milliseconds = Math.floor((timeDiff % 1) * 1000);
      console.log(`-t ${hours}:${minutes}:${seconds}.${milliseconds}`);
      const startBlankFile = `./${camera}_start_blank.mp4`;
      await new Promise((resolve, reject)=>{ffmpeg('color=size=1920x1080:rate=29.97:color=black').inputFormat('lavfi').input('anullsrc=channel_layout=stereo:sample_rate=48000').inputFormat('lavfi')
        .outputOptions([`-t ${hours}:${minutes}:${seconds}.${milliseconds}`])
        .on('error', function(err) {
          reject(err);
        })
        .on('end', function(){
          console.log('finished running blank at start of camera');
          resolve();
        })
        .save(startBlankFile)
        .run()});
      mergeFiles.push(startBlankFile);
    }

    if (data[camera].start_diff != 0.0 || data[camera].end_diff != 0.0) {
      mergeFiles.push(`./${camera}_concat.mp4`);
    }

    if (data[camera].end_diff != 0.0) {
      var timeDiff = data[camera].end_diff;
      var hours = Math.floor(timeDiff / 3600);
      var minutes = Math.floor((timeDiff - (hours * 3600)) / 60);
      var seconds = Math.floor(timeDiff - (minutes * 60) - (hours * 3600));
      var milliseconds = Math.floor((timeDiff % 1) * 1000);
      console.log(`-t ${hours}:${minutes}:${seconds}.${milliseconds}`);
      const endBlankFile = `./${camera}_end_blank.mp4`;
      await new Promise((resolve, reject)=>{ffmpeg('color=size=1920x1080:rate=29.97:color=black').inputFormat('lavfi').input('anullsrc=channel_layout=stereo:sample_rate=48000').inputFormat('lavfi')
        .outputOptions([`-t ${hours}:${minutes}:${seconds}.${milliseconds}`])
        .on('error', function(err) {
          reject(err);
        })
        .on('end', function(){
          console.log('finished running blank at end of camera');
          resolve();
        })
        .save(endBlankFile)
        .run()});
      mergeFiles.push(endBlankFile);
    }

    console.log(mergeFiles);

    if (mergeFiles.length != 0) {
      var txtFile = './merge_array.txt';
      var fileNames = '';
      mergeFiles.forEach((fileName, index) => {
        fileNames = `${fileNames}file ` + `'${fileName}'\n`;
      });
      await fs.writeFileSync(txtFile, fileNames);
      const saveFile = `./final_${camera}_concat.mp4`;
      finalVideos.push(saveFile);
      await new Promise((resolve, reject)=>{ffmpeg().input(txtFile).inputOptions(['-f concat', '-safe 0']).outputOptions('-c copy')
        .on('error', function(err) {
          reject(err);
        })
        .on('end', function(){
          console.log('finished running combining camera buffers');
          resolve();
        })
        .save(saveFile).run()});
    } else {
      finalVideos.push(`./${camera}_concat.mp4`);
    }

    console.log(finalVideos);
  }

  // Put the videos from each camera side-by-side
  // Adapted from https://stackoverflow.com/questions/38234357/node-js-ffmpeg-display-two-videos-next-to-each-other
  var txtFile = './merge_array.txt'
  var fileNames = '';
  finalVideos.forEach(function(fileName, index) {
      fileNames = fileNames + 'file ' + "'" + fileName + "'\n";
  });
  console.log(fileNames);
  await fs.writeFileSync(txtFile, fileNames);
  try {
  await new Promise((resolve, reject)=>{ffmpeg().input(txtFile)
    .complexFilter([
      '[0:v]scale=300:300[0scaled]',
      '[1:v]scale=300:300[1scaled]',
      '[0scaled]pad=600:300[0padded]',
      '[0padded][1scaled]overlay=shortest=1:x=300[output]'
    ])
    .outputOptions([
      '-map [output]'
    ])
    .on("error",function(er){
      console.log("error occured: "+er.message);
      reject(er);
    })
    .on("end",function(){
      console.log("successful final merge");
      resolve();
    })
    .save("./full_view.mp4").run()});
  } catch (err) {
    console.log(err);
  }
}

// Run the script
//const t = run('/media/CAR_PROJECTS/Bremers_FamilyCarTrip/P3_03132021/Video_Audio/'); 
const t = run('/Users/sam/Documents/CornellTech/FARLab/Nissan/p3/gopro_data/');