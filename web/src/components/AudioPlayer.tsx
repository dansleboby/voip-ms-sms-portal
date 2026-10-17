import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Download, Loader2, Pause, Play } from 'lucide-react';
import { locale, t } from '../i18n';
import { formatDuration, prepareAudio, WAVEFORM_BARS, type PreparedAudio } from '../lib/audio';

const SPEEDS = [1, 1.5, 2];
const FLAT: number[] = Array(WAVEFORM_BARS).fill(0.15);

/** One message plays at a time: starting one pauses the other. */
let current: HTMLAudioElement | null = null;

/**
 * Voice message player: a play button, the waveform as the progress bar
 * (tap or drag it to move in the message), the time, and the speed once
 * it has played.
 */
export function AudioPlayer({ url }: { url: string }) {
  const [audio, setAudio] = useState<PreparedAudio | null>(null);
  // Not decodable here: the browser may still play the file, without its waveform.
  const [undecoded, setUndecoded] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const el = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let live = true;
    prepareAudio(url).then(
      (prepared) => {
        if (!live) return;
        setAudio(prepared);
        setDuration(prepared.duration);
      },
      () => live && setUndecoded(true),
    );
    return () => {
      live = false;
    };
  }, [url]);

  // timeupdate comes about four times a second: too seldom for the bars to fill smoothly.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      if (el.current) setTime(el.current.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const src = audio?.src ?? (undecoded ? url : undefined);

  const toggle = () => {
    const a = el.current;
    if (!a) return;
    if (!a.paused) return a.pause();
    if (current && current !== a) current.pause();
    current = a;
    a.playbackRate = speed;
    // A file the browser cannot play fires "error", handled below.
    a.play().catch(() => undefined);
  };

  const seek = (fraction: number) => {
    const a = el.current;
    if (!a || !duration) return;
    a.currentTime = Math.max(0, Math.min(1, fraction)) * duration;
    setTime(a.currentTime);
    setStarted(true);
  };

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const box = e.currentTarget.getBoundingClientRect();
    seek((e.clientX - box.left) / box.width);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
    if (step !== undefined) seek((time + step) / duration);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(1);
    else return;
    e.preventDefault();
  };

  const changeSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!;
    setSpeed(next);
    if (el.current) el.current.playbackRate = next;
  };

  if (unplayable) {
    return (
      <a className="file-chip" href={url} download>
        <Download size={18} />
        {t('attachment.audio')}
      </a>
    );
  }

  const peaks = audio?.peaks ?? FLAT;
  const progress = duration ? time / duration : 0;
  return (
    <div className="audio-player">
      <button
        type="button"
        className="audio-play"
        disabled={!src}
        aria-label={playing ? t('audio.pause') : t('audio.play')}
        onClick={toggle}
      >
        {!src ? <Loader2 size={18} className="spin" /> : playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div
        className="waveform"
        role="slider"
        tabIndex={src ? 0 : -1}
        aria-label={t('audio.position')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={`${formatDuration(time)} / ${formatDuration(duration)}`}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onKeyDown={onKey}
      >
        {peaks.map((peak, i) => (
          <span key={i} className={(i + 0.5) / peaks.length <= progress ? 'played' : undefined} style={{ height: `${Math.round(peak * 100)}%` }} />
        ))}
      </div>
      <span className="audio-time">{duration ? formatDuration(started ? time : duration) : ''}</span>
      {/* Kept in the layout before it shows, so that the player does not grow when it starts. */}
      <button type="button" className="audio-speed" style={started ? undefined : { visibility: 'hidden' }} aria-label={t('audio.speed')} onClick={changeSpeed}>
        {new Intl.NumberFormat(locale()).format(speed)}×
      </button>
      <audio
        ref={el}
        src={src}
        preload="metadata"
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          e.currentTarget.currentTime = 0;
          setTime(0);
          setStarted(false);
        }}
        onLoadedMetadata={(e) => {
          if (!duration && Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
        onError={() => src && setUnplayable(true)}
      />
    </div>
  );
}
