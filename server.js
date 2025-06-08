const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

// --- CONFIGURACIÓN ---
const app = express();
const PORT = 3000;
const VIDEOS_DIR = path.join(__dirname, 'videos');
const CACHE_DIR = path.join(__dirname, 'cache');
const runningProcesses = {};

try {
    const FFMPEG_PATH = require('ffmpeg-static');
    const FFPROBE_PATH = require('ffprobe-static').path;
    ffmpeg.setFfmpegPath(FFMPEG_PATH);
    ffmpeg.setFfprobePath(FFPROBE_PATH);
} catch (e) {
    console.error("Error: Faltan paquetes. Ejecuta 'npm install ffmpeg-static ffprobe-static'");
    process.exit(1);
}

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/cache', express.static(CACHE_DIR));

// --- API ---

app.get('/api/videos', (req, res) => {
    fs.readdir(VIDEOS_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: "Error al leer directorio." });
        res.json(files.filter(file => /\.(mkv|mp4|avi|mov)$/i.test(file)));
    });
});

app.get('/api/probe/:videoFile', (req, res) => {
    const videoFile = req.params.videoFile;
    const videoPath = path.join(VIDEOS_DIR, videoFile);
    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video no encontrado.' });

    ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return res.status(500).json({ error: 'Fallo al analizar el video.' });
        res.json(metadata.streams);
    });
});

app.get('/transcode/:videoFile', (req, res) => {
    const videoFile = req.params.videoFile;
    const videoPath = path.join(VIDEOS_DIR, videoFile);

    if (runningProcesses[videoFile]) {
        runningProcesses[videoFile].kill('SIGKILL');
    }

    if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'Video no encontrado.' });

    const outputDir = path.join(CACHE_DIR, path.parse(videoFile).name);
    if (fs.existsSync(outputDir)) fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    const quality = req.query.quality || '720p';
    const audioIndex = req.query.audioIndex || '0:a:0';
    const subtitleIndex = req.query.subtitleIndex; 

    const qualities = {
        '1080p': { resolution: '1920x1080', vb: '5000k' },
        '720p': { resolution: '1280x720', vb: '2800k' },
        '480p': { resolution: '854x480', vb: '1000k' }
    };
    const selectedQuality = qualities[quality] || qualities['720p'];

    console.log(`[INFO] Iniciando transcodificación para ${videoFile}`);
    console.log(`[INFO] Calidad: ${quality}, Audio: ${audioIndex}, Subtítulo: ${subtitleIndex || 'Ninguno'}`);

    const command = ffmpeg(videoPath)
        .addOptions([
            '-map', '0:v:0',
            '-map', audioIndex,
        ])
        .addOptions([ 
            '-c:v', 'libx264',
            '-b:v', selectedQuality.vb,
            '-s', selectedQuality.resolution,
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p'
        ])
        .addOptions([
            '-c:a', 'aac',
            '-ac', '2', 
            '-b:a', '128k'
        ])
        .addOptions([
            '-f', 'hls',
            '-hls_time', '4',
            '-hls_list_size', '0'
        ]);
    
    if (subtitleIndex) {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if(metadata) {
                const streamIndex = parseInt(subtitleIndex.split(':')[2]);
                const subtitleStream = metadata.streams.find(s => s.index === streamIndex);
                
                if (subtitleStream && ['subrip', 'ass'].includes(subtitleStream.codec_name)) {
                    command.addOptions(['-map', subtitleIndex, '-c:s', 'webvtt']);
                    console.log(`[INFO] Mapeando subtítulo de texto compatible (${subtitleStream.codec_name}).`);
                } else {
                    console.log(`[AVISO] Se ignoró el subtítulo con formato de imagen (${subtitleStream?.codec_name || 'desconocido'}), no se puede convertir.`);
                }
            }
            startTranscoding(command, outputDir, res, videoFile);
        });
    } else {
        startTranscoding(command, outputDir, res, videoFile);
    }
});

function startTranscoding(command, outputDir, res, videoFile) {
    command.output(path.join(outputDir, 'playlist.m3u8'));

    command.on('start', (commandLine) => console.log('[FFMPEG] Comando Final:\n' + commandLine));
    command.on('error', (err, stdout, stderr) => {
        if (!err.message.includes('killing process')) {
            console.error('[ERROR] FFmpeg falló:', err.message);
            console.error('[STDERR]', stderr);
        }
    });
    command.on('end', () => console.log('[INFO] Transcodificación finalizada.'));
    
    command.run();
    runningProcesses[videoFile] = command;

    const manifestPath = path.join(outputDir, 'playlist.m3u8');
    const checkInterval = setInterval(() => {
        if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).size > 0) {
            clearInterval(checkInterval);
            res.json({ manifestUrl: `/cache/${path.parse(videoFile).name}/playlist.m3u8` });
        }
    }, 500);
}

app.listen(PORT, () => console.log(`✅ Servidor Final listo en http://localhost:${PORT}`));