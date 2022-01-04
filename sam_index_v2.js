// Formatting caveats - can remove if wished
/* eslint-disable prefer-destructuring */
/* eslint-disable global-require */
/* eslint-disable import/no-dynamic-require */
/* eslint-disable no-redeclare */
/* eslint-disable camelcase */
/* eslint-disable no-param-reassign */
/* eslint-disable consistent-return */
/* eslint-disable no-debugger */
/* eslint-disable no-console */
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */
/* eslint-disable no-loop-func */
/* eslint-disable no-await-in-loop */
/* eslint-disable block-scoped-var */
/* eslint-disable no-var */
/* eslint-disable vars-on-top */
/* eslint-disable no-restricted-syntax */
/* eslint-disable max-len */

// Example of how to run the script
// node sam_index_v2.js '/media/CAR_PROJECTS/Bremers_FamilyCarTrip/P8_05092021/Video_Audio/' 8 'Driver' '{"Driver": 2, "Navigator": 1}' 1

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
// DONE          g. Save this master video
// OPEN          h. Save the telemetry data for this camera
// DONE       2. Find the earliest start time for each camera
// DONE          a. For any videos with start times later than the earliest start time, append
//                  blank time at the beginning of the processed clip to align them
// DONE          b. Do the same with the end of the video
// DONE       3. Use ffmpeg to put the videos side-by-side for all videos for an individual
//               participant
// DONE       4. Save this video to the main p[num] folder

// PROGRESS | VARIOUS TO-DOs
// OPEN       1. Remove slices to allow run over all cameras/videos
// DONE       2. Change the filePath to be a command line argment where the
//               user can input the path to the participant
// DONE       3. Change the output files to save to a command line argument path
//               rather than this directory
// OPEN       4. Reduce the output file sizes (give a variety of resolutions?)

// PROGRESS | CURRENT BUGS
// DEBUG      1. Some strangeness with timing on p${participant_ind}/P6 for the videos -> maybe frame rate stuff?
// OPEN       2. Merging audio doesn't quite work yet, some weird offset right now
// OPEN       3. Try switching camera order to see if first two always sync properly

// Import packages
const gpmfExtract = require('gpmf-extract'); // https://github.com/JuanIrache/gpmf-extract
const goproTelemetry = require('gopro-telemetry'); // https://github.com/JuanIrache/gopro-telemetry
const {
  createReadStream, writeFileSync, promises, mkdirSync, fs,
} = require('fs');
const glob = require('glob-promise');
const ffmpeg = require('fluent-ffmpeg'); // https://www.npmjs.com/package/fluent-ffmpeg
const DateTime = require('luxon').DateTime;


// Handle bug in gpmf-extract for large video files
// Read more about this here: https://github.com/JuanIrache/gpmf-extract
function bufferAppender(path, chunkSize) {
  return function (mp4boxFile) {
    const stream = createReadStream(path, { highWaterMark: chunkSize });
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
  debugger;
  const startIndex = data.map((i) => i.value[0]).findIndex((lng) => lng > 0);
  const startTime = DateTime.fromISO(data[Object.keys(data).length - 1].date.toISOString()).minus(data[Object.keys(data).length - 1].cts);
  const adjusted = data.map((sample) => {
    sample.date = startTime.plus(sample.cts).toUTC().toString();
    return sample;
  });
  return adjusted;
}

async function processVid(vidPath) {
  const fileData = await gpmfExtract(bufferAppender(vidPath, 10 * 1024 * 1024));
  var duration = fileData.timing.videoDuration;
  const telemetry = await goproTelemetry(fileData);

  // this heuristic isn't perfect and might want to be refined
  telemetry['1'].streams.GPS5.samples = await adjustTimestamps(telemetry['1'].streams.GPS5.samples);
  console.log(`Start time: ${new Date(telemetry['1'].streams.GPS5.samples[0].date).toLocaleString('en-US')}`);

  return [new Date(telemetry['1'].streams.GPS5.samples[0].date).getTime(), duration];
}

var fileOrder = {};

// Get all of the files in the filepath with `GOPR` in the name and process each
async function run(filePath, participant_ind, rotate, audioStream, fullRun) {
  const currPath = process.cwd();

  // Each file is formatted as GOPR[ID].mp4 for the first chunk in a video sequence
  // subsequent chunks in the same video are formatted as GP[ind][ID].mp4
  var files = await glob(`${filePath}*/*.MP4`);
  const pathLen = filePath.split('/').length;

  // Make it easier to break up the data by organizing by camera
  const cameras = files.map((val) => val.split('/')[pathLen - 1].split('/')[0]);
  var uniqueCameras = cameras.filter(onlyUnique);
  console.log(`Cameras: ${uniqueCameras}`);
  for (const cam of uniqueCameras) {
    fileOrder[cam] = [];

    // Pull the relevant "starter" files for that camera and sort them
    // TODO: FIGURE OUT THE 10 VS 9 INDEX NONSENSE***************************
    const goprFiles = await glob(`${filePath + cam}/GOPR*.MP4`);
    goprFiles.sort();

    for (const gopr of goprFiles) {
      fileOrder[cam].push(gopr);

      // Pull the secondary files for each recording, sort, and add to the ordering
      const fileID = gopr.split('GOPR')[1];
      // TODO: FIGURE OUT THE 10 VS 9 INDEX NONSENSE***************************
      const gpFiles = await glob(`${filePath + cam}/GP*${fileID}`);
      gpFiles.sort();

      for (const gp of gpFiles) {
        fileOrder[cam].push(gp);
      }
    }
  }

  let earliest_start = Infinity;
  let latest_end = 0;

  // Try to read in the file distribution information. If it doesn't exist, make it
  var distExist = false;
  try {
    var data = require(`${currPath}/p${participant_ind}/file_dist.json`);
    if (fullRun == 1) {
      console.log('Flag set to ignore cached file data... Running full load now...');
    } else {
      distExist = true;
    }
  } catch (err) {
    console.log('Have not run this before, pulling file data now...');
  }

  if (distExist == false) {
    var data = {};
  }

  for (const camera of uniqueCameras) {
    var mergeFiles = [];
    var blankFiles = [];
    let prevEnd;

    for (const [idx, file] of fileOrder[camera].entries()) {
      console.log(`${camera}...processing ${idx + 1} of ${fileOrder[camera].length}: ${file}`);

      try {
        if (distExist === false) {
          // Add the start time, duration, and geo binary for this file
          const [startTime, duration] = await processVid(file); // new Date(fileData.timing.start).getTime() / 1000;
          if (!(camera in data)) {
            data[camera] = {};
          }
          data[camera][file] = {};
          data[camera][file].start_time = startTime;
          data[camera][file].duration = duration * 1000;
        }

        // Get difference in time with the previous file and add a buffer video if necessary
        if (idx === 0) {
          var cameraStart = data[camera][file].start_time;
          var runningDur = data[camera][file].duration;
          prevEnd = data[camera][file].start_time + data[camera][file].duration;
          mergeFiles.push(file);
        } else {
          // TODO: KEEP YOURSELF SANE WITH MS VS S
          // Account for the duration being full length for broken up videos. If video broken up, ignore the offset
          var timeDiff = Math.max((data[camera][file].start_time - prevEnd) / 1000, 0.0);

          // TODO: this should be cleaned
          // Reduce time for when cameras are turned off to save on file size during long breaks
          while (timeDiff > 4000) {
            timeDiff -= 3600;
          }

          // TODO: THIS CAN ALSO SAVE SANITY -> KEEP SANITY, IT'S GOOD FOR YOU
          var hours = Math.floor(timeDiff / 3600);
          var minutes = Math.floor((timeDiff - (hours * 3600)) / 60);
          var seconds = timeDiff - (minutes * 60) - (hours * 3600);
          console.log(`-t ${hours}:${minutes}:${seconds}`);

          prevEnd = data[camera][file].start_time + data[camera][file].duration;
          runningDur = runningDur + timeDiff + data[camera][file].duration;

          const blankFile = `${currPath}/p${participant_ind}/${idx}_blank.mp4`;
          await new Promise((resolve, reject) => {
            ffmpeg('color=size=1920x1080:rate=23.98:color=black').inputFormat('lavfi').input('anullsrc=channel_layout=stereo:sample_rate=48000').inputFormat('lavfi')
              .outputOptions([`-t ${hours}:${minutes}:${seconds}`])
              .on('error', function (err) {
                reject(err);
              })
              .on('end', function () {
                console.log('finished running blank between same camera videos');
                resolve();
              })
              .save(blankFile)
              .run();
          });
          mergeFiles.push(blankFile);
          blankFiles.push(blankFile);
          mergeFiles.push(file);
        }
      } catch (err) {
        console.log(`Error: ${err}`);
        break;
      }
    }

    // Merge the files together after writing the file array to a txt file
    // Adapted from https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/496
    var txtFile = `${currPath}/p${participant_ind}/merge_array.txt`;
    var fileNames = '';
    mergeFiles.forEach((fileName) => {
      fileNames = `${fileNames}file '${fileName}'\n`;
    });
    console.log(`Merging: ${mergeFiles}`);
    await writeFileSync(txtFile, fileNames);
    try {
      await new Promise((resolve, reject) => {
        ffmpeg().input(txtFile).inputOptions(['-f concat', '-safe 0', '-r 23.98']).outputOptions(['-c copy']) // , '-vcodec libx265', '-crf 24'])
          .on('error', function (err) {
            reject(err);
          })
          .on('end', function () {
            console.log('finished running merge for camera');
            resolve();
          })
          .save(`p${participant_ind}/${camera}_concat.mp4`)
          .run();
      });
    } catch (err) {
      console.log(err);
    }

    // TODO: IS THIS ACTUALLY WORKING??
    // Clean up the blank files
    /* blankFiles.forEach((fileName) => {
      fs.unlinkSync(fileName);
    }); */

    // TODO: EVENTUALLY AVOID BROKEN CAMERAS
    if (distExist == false && camera in data) {
      // Save the concat file info for analysis across cameras
      data[camera].concat_start = cameraStart / 1000;
      data[camera].concat_duration = runningDur / 1000;
    }

    // TODO MAKE TIMES READABLE
    if (camera in data) {
      console.log('Camera start time:');
      console.log(cameraStart);

      console.log('Camera duration:');
      console.log(runningDur);

      // Find the earliest start time
      earliest_start = Math.min(earliest_start, data[camera].concat_start);
      latest_end = Math.max(latest_end, data[camera].concat_start + data[camera].concat_duration);

      console.log('Global start/end:');
      console.log(earliest_start);
      console.log(latest_end);
    }
  }

  var finalVideos = [];
  for (const camera of Object.keys(data)) {
    var mergeFiles = [];
    if (distExist === false && camera in data) {
      data[camera].start_diff = data[camera].concat_start - earliest_start;
      data[camera].end_diff = latest_end - (data[camera].concat_duration + data[camera].concat_start);
    }

    // TODO: MAKE TIMES READABLE
    console.log('Time Differences:');
    console.log(data[camera].start_diff);
    console.log(data[camera].end_diff);

    if (data[camera].start_diff !== 0.0) {
      var timeDiff = data[camera].start_diff;
      var hours = Math.floor(timeDiff / 3600);
      var minutes = Math.floor((timeDiff - (hours * 3600)) / 60);
      var seconds = timeDiff - (minutes * 60) - (hours * 3600);
      console.log(`-t ${hours}:${minutes}:${seconds}`);
      const startBlankFile = `${currPath}/p${participant_ind}/${camera}_start_blank.mp4`;
      await new Promise((resolve, reject) => {
        ffmpeg('color=size=1920x1080:rate=23.98:color=black').inputFormat('lavfi').input('anullsrc=channel_layout=stereo:sample_rate=48000').inputFormat('lavfi')
          .outputOptions([`-t ${hours}:${minutes}:${seconds}`])
          .on('error', function (err) {
            reject(err);
          })
          .on('end', function () {
            console.log('finished running blank at start of camera');
            resolve();
          })
          .save(startBlankFile)
          .run();
      });
      mergeFiles.push(startBlankFile);
    }

    if (data[camera].start_diff !== 0.0 || data[camera].end_diff !== 0.0) {
      mergeFiles.push(`${currPath}/p${participant_ind}/${camera}_concat.mp4`);
    }

    if (data[camera].end_diff !== 0.0) {
      var timeDiff = data[camera].end_diff;
      var hours = Math.floor(timeDiff / 3600);
      var minutes = Math.floor((timeDiff - (hours * 3600)) / 60);
      var seconds = timeDiff - (minutes * 60) - (hours * 3600);
      console.log(`-t ${hours}:${minutes}:${seconds}`);
      const endBlankFile = `${currPath}/p${participant_ind}/${camera}_end_blank.mp4`;
      await new Promise((resolve, reject) => {
        ffmpeg('color=size=1920x1080:rate=23.98:color=black').inputFormat('lavfi').input('anullsrc=channel_layout=stereo:sample_rate=48000').inputFormat('lavfi')
          .outputOptions([`-t ${hours}:${minutes}:${seconds}`])
          .on('error', function(err) {
            reject(err);
          })
          .on('end', function () {
            console.log('finished running blank at end of camera');
            resolve();
          })
          .save(endBlankFile)
          .run();
      });
      mergeFiles.push(endBlankFile);
    }

    if (mergeFiles.length !== 0) {
      var txtFile = `${currPath}/p${participant_ind}/merge_array.txt`;
      var fileNames = '';
      mergeFiles.forEach((fileName) => {
        fileNames = `${fileNames}file '${fileName}'\n`;
      });
      console.log(`Merging ${mergeFiles}`);
      await writeFileSync(txtFile, fileNames);
      const saveFile = `${currPath}/p${participant_ind}/final_${camera}_concat.mp4`;
      await new Promise((resolve, reject) => {
        ffmpeg().input(txtFile).inputOptions(['-f concat', '-safe 0', '-r 23.98']).outputOptions(['-c copy'])
          .on('error', function(err) {
            reject(err);
          })
          .on('end', function () {
            console.log('finished running combining camera buffers');
            resolve();
          })
          .save(saveFile)
          .run();
      });
    } else {
      finalVideos.push(`${currPath}/p${participant_ind}/${camera}_concat.mp4`);
    }

    // TODO: FOR CASE WHERE NO BUFFER ADDED
    if (camera in rotate) {
      await new Promise((resolve, reject) => {
        ffmpeg().input(`${currPath}/p${participant_ind}/final_${camera}_concat.mp4`).withVideoFilter([`transpose=${rotate[camera]}`])
          .on('error', function (err) {
            reject(err);
          })
          .on('end', function () {
            console.log('rotated');
            resolve();
          })
          .save(`${currPath}/p${participant_ind}/final_${camera}_rot_concat.mp4`)
          .run();
      });
      finalVideos.push(`${currPath}/p${participant_ind}/final_${camera}_rot_concat.mp4`);
    } else {
      if (camera != 'Navigator') {
        finalVideos.push(`${currPath}/p${participant_ind}/final_${camera}_concat.mp4`);
      }
    }
  }

  if (distExist === false) {
    // Save the file distribution to json for easier access
    // if the outfolder doesn't exist make it
    await promises.access(`${currPath}/p${participant_ind}`)
      .catch(async (e) => {
        if (e.code === 'ENOENT') {
          mkdirSync(`${currPath}/p${participant_ind}`);
        } else {
          console.log(e);
        }
      });
    await promises.writeFile(`${currPath}/p${participant_ind}/file_dist.json`, JSON.stringify(data));
  }

  // Get the index of the audio stream to use
  var audioInd = cameras.indexOf(audioStream);

  // TODO: MAKE THIS AN ACTUAL FUNCTION BASED ON NUMBER OF VIDEO STREAMS
  // Put the videos from each camera side-by-side
  // Sound mix from https://stackoverflow.com/questions/44712868/ffmpeg-set-volume-in-amix 
  // Adapted from https://stackoverflow.com/questions/38234357/node-js-ffmpeg-display-two-videos-next-to-each-other
  var txtFile = `${currPath}/p${participant_ind}/merge_array.txt`;
  var fileNames = '';
  finalVideos.forEach(function (fileName) {
    fileNames = `${fileNames}file '${fileName}'\n`;
  });
  console.log(`Merging: ${finalVideos}`);
  await writeFileSync(txtFile, fileNames);
  if (finalVideos.length === 2) {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(finalVideos[0])
        .input(finalVideos[1])
        .complexFilter([
          '[0:v]scale=300:300[0scaled]',
          '[1:v]scale=300:300[1scaled]',
          '[0scaled]pad=600:300[0padded]',
          '[0padded][1scaled]overlay=repeatlast:x=300[output]',
        ])
        .outputOptions([
          '-map [output]', `-map ${audioInd}:a`, '-c:a copy',
        ])
        .on('error', function (er) {
          console.log(`error occurred: ${er.message}`);
          reject(er.message);
        })
        .on('end', function () {
          console.log('successful final merge');
          resolve();
        })
        .save(`${currPath}/p${participant_ind}/full_view.mp4`)
        .run();
    });
  } else if (finalVideos.length === 3) {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(finalVideos[0])
        .input(finalVideos[1])
        .input(finalVideos[2])
        .complexFilter([
          '[0:v]scale=300:300[0scaled]',
          '[1:v]scale=300:300[1scaled]',
          '[2:v]scale=300:300[2scaled]',
          '[0scaled]pad=600:600[0padded]',
          '[0padded][1scaled]overlay=repeatlast:x=300[preoutput]',
          '[preoutput][2scaled]overlay=repeatlast:x=150:y=300[output]',
          '[0:a][1:a][2:a]amix=inputs=3[a]',
        ])
        .outputOptions([
          '-map [output]', '-map [a]:a',
        ])
        .on('error', function (er) {
          console.log(`error occurred: ${er.message}`);
          reject(er.message);
        })
        .on('end', function () {
          console.log('successful final merge');
          resolve();
        })
        .save(`${currPath}/p${participant_ind}/full_view.mp4`)
        .run();
    });
  } else if (finalVideos.length === 4) {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(finalVideos[0])
        .input(finalVideos[1])
        .input(finalVideos[2])
        .input(finalVideos[3])
        .complexFilter([
          '[0:v]scale=300:300[0scaled]',
          '[1:v]scale=300:300[1scaled]',
          '[2:v]scale=300:300[2scaled]',
          '[3:v]scale=300:300[3scaled]',
          '[0scaled]pad=600:600[0padded]',
          '[0padded][1scaled]overlay=repeatlast:x=300[preoutput]',
          '[preoutput][2scaled]overlay=repeatlast:y=300[preoutput]',
          '[preoutput][3scaled]overlay=repeatlast:x=300:y=300[output]',
        ])
        .outputOptions([
          '-map [output]', `-map ${audioInd}:a`, '-c:a copy',
        ])
        .on('error', function (er) {
          console.log(`error occurred: ${er.message}`);
          reject(er.message);
        })
        .on('end', function () {
          console.log('successful final merge');
          resolve();
        })
        .save(`${currPath}/p${participant_ind}/full_view.mp4`)
        .run();
    });
  } else {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(finalVideos[0])
        .input(finalVideos[1])
        .input(finalVideos[2])
        .input(finalVideos[3])
        .input(finalVideos[4])
        .complexFilter([
          '[0:v]scale=300:300[0scaled]',
          '[1:v]scale=300:300[1scaled]',
          '[2:v]scale=300:300[2scaled]',
          '[3:v]scale=300:300[3scaled]',
          '[4:v]scale=300:300[4scaled]',
          '[0scaled]pad=900:600[0padded]',
          '[0padded][1scaled]overlay=repeatlast:x=300[preoutput]',
          '[preoutput][2scaled]overlay=repeatlast:x=600[preoutput]',
          '[preoutput][3scaled]overlay=repeatlast:x=150:y=300[preoutput]',
          '[preoutput][4scaled]overlay=repeatlast:x=450:y=300[output]',
        ])
        .outputOptions([
          '-map [output]', `-map ${audioInd}:a`, '-c:a copy',
        ])
        .on('error', function (er) {
          console.log(`error occurred: ${er.message}`);
          reject(er.message);
        })
        .on('end', function () {
          console.log('successful final merge');
          resolve();
        })
        .save(`${currPath}/p${participant_ind}/full_view.mp4`)
        .run();
    });
  }

  // Clean up the blank files
  /* mergeFiles.forEach((fileName) => {
    fs.unlinkSync(fileName);
  });

  finalVideos.forEach((fileName) => {
    try {
      fs.unlinkSync(fileName);
    } catch (err) {
      console.log(err);
    }
  }); */
}

// Run the script
var args = process.argv.slice(2);
var dataPath = args[0];
var participantID = args[1];
var audioStream = args[2];
var rotations = JSON.parse(args[3].toString());
var fullRun = args[4];
run(dataPath, participantID, rotations, audioStream, fullRun);
