// APROACH
// 1. For each camera: find the different files
//    a. Order the files
//    b. Get the start time (unix time from the gpmf-extract object 'start') for each and the length 
//       of the video
//    e. Find the difference between end time (from the duration/start time) and the next
//       start time for each subsequent video
//    f. Loop through the videos and append them with blank time when there is a gap between
//       end time and start time of the next video
//       (NOTE: should loop through each GP video for each GOPR and append before appending
//       data from the next GOPR vclip)
//    g. Save this master video
//    h. Save the telemetry data for this camera
// 2. Find the earliest start time for each camera
//    a. For any videos with start times later than the earliest start time, append 
//       blank time at the beginning of the processed clip to align them
//    b. Do the same with the end of the video
// 3. Use ffmpeg to put the videos side-by-side for all videos for an individual 
//    participant
// 4. Save this video to the main p[num] folder

// Import packages
const gpmfExtract = require('gpmf-extract'); // https://github.com/JuanIrache/gpmf-extract
const goproTelemetry = require(`gopro-telemetry`); // https://github.com/JuanIrache/gopro-telemetry
const fs = require('fs');
const glob = require('glob-promise');
const ffmpeg = require('fluent-ffmpeg'); // https://www.npmjs.com/package/fluent-ffmpeg
const spawn = require('child_process');

// Set the path of videos to analyze
const filePath = '/media/CAR_PROJECTS/Bremers_FamilyCarTrip/P5_04172021/Video_Audio/';
// TO DO: add command line parameter for specifying participant number

// Set up data holders
const fileOrder = {}

// Handle bug in gpmf-extract for large video files
// Read more about this here: https://github.com/JuanIrache/gpmf-extract
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

// borrowed from https://stackoverflow.com/questions/1960473/get-all-unique-values-in-a-javascript-array-remove-duplicates
function onlyUnique(value, index, self) {
    return self.indexOf(value) === index;
  }

// Get all of the files in the filepath with `GOPR` in the name and process each
async function run(){

    // Each file is formatted as GOPR[ID].mp4 for the first chunk in a video sequence
    // subsequent chunks in the same video are formatted as GP[ind][ID].mp4
    const files = await glob(filePath + '*/*.MP4');
    const pathLen = filePath.split('/').length;
    var fileData;

    // Make it easier to break up the data by organizing by camera
    const cameras = files.map(val => val.split('/')[pathLen - 1].split('/')[0]);
    const uniqueCameras = cameras.filter(onlyUnique);
    console.log(`Cameras: ${uniqueCameras}`);
    for (const cam of uniqueCameras) {
        fileOrder[cam] = [];

        // Pull the relevant "starter" files for that camera and sort them
        var goprFiles = await glob(filePath + cam + '/GOPR*.MP4');
        goprFiles.sort();

        for (const gopr of goprFiles) {
            fileOrder[cam].push(gopr);

            // Pull the secondary files for each recording, sort, and add to the ordering
            var fileID = gopr.split('GOPR')[1];
            var gpFiles = await glob(filePath + cam + '/GP*' + fileID);
            gpFiles.sort();

            for (const gp of gpFiles) {
                fileOrder[cam].push(gp);
            }
        }
    }

    // Run the combination logic for each camera
    for (const camera of uniqueCameras.slice(0,1)) {
        var data = {};
        var ind = 0;
        var prevEnd;
        var camVid;

        data[camera] = {};

        // REMOVE WHEN DONE:  Start with just two video files for testing
        for (const file of fileOrder[camera].slice(0,2)) {
            console.log(`${camera}...processing ${ind} of ${fileOrder[camera].length}: ${file}`)

            // Get the gpmf-extract binary object for this file (adjusted with bufferAppender)
            // Add the gpmf-extract binary data to the data object for analysis
            try {
                fileData = await gpmfExtract(bufferAppender(file, 10 * 1024 * 1024))
            } catch (error) {
                console.log(error)
                break;
            }

            // Add the start time, duration, and geo binary for this file
            data[camera][file] = {};
            data[camera][file]['results'] = fileData;
            data[camera][file]['start_time'] = new Date(fileData.timing.start).getTime() / 1000;
            data[camera][file]['duration'] = (fileData.timing.frameDuration * fileData.timing.videoDuration) * 60;

            // Get difference in time with the previous file and add a buffer video if necessary
            if (ind == 0) {
                camVid = ffmpeg(file);
                prevEnd = data[camera][file]['start_time'] + data[camera][file]['duration'];
            } else {
                var timeDiff = data[camera][file]['start_time'] - prevEnd;
                console.log(timeDiff);
                const child = spawn(`ffmpeg -f lavfi -i color=size=1920x1080:rate=29.97:color=black -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 -t 10 test_output.mp4`)
            }

            // Iterate the file index
            ind++;
        }

        // Wait for the data object to be populated and logged
        await console.log(data)

        // Extract the telemetry data from the first value in the data array
        const telemetry = await goproTelemetry(data['Rear_Right/'][fileOrder['Rear_Right'][0]]['results'])
        console.log(JSON.stringify(telemetry))

        // Save the data to an output file
        await fs.promises.writeFile('output_sam.json', JSON.stringify(telemetry))
        console.log('saved!')
    }
}

// Run the script
run()
