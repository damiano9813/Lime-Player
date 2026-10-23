package com.xtreamplayer.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

@InvokeArg
class WatchArgs {
  lateinit var channel: Channel
}

@InvokeArg
class LoadArgs {
  var url: String = ""
  var live: Boolean = false
  var start: Double? = null
  var cacheSecs: Double? = null
  var alang: String = ""
  var slang: String = ""
  var audio: String = "stereo"
  var volume: Double? = null
  var mute: Boolean? = null
  var title: String = ""
  var userAgent: String = ""
}

@InvokeArg
class SetArgs {
  var name: String = ""
  var value: String = ""
}

@InvokeArg
class SeekArgs {
  var secs: Double = 0.0
}

@InvokeArg
class RectArgs {
  var x: Double = 0.0
  var y: Double = 0.0
  var w: Double = 0.0
  var h: Double = 0.0
  // larghezza della pagina in px CSS
  var vw: Double = 0.0
  var visible: Boolean = false
}

@InvokeArg
class OrientationArgs {
  var landscape: Boolean = false
}

@InvokeArg
class UrlArgs {
  var url: String = ""
}

@InvokeArg
class ExternalArgs {
  var url: String = ""
  var title: String = ""
  var prefer: String = ""
}

/**
 * Plugin dell'app Android. ExoPlayer disegna il video in una PlayerView sotto la WebView
 * trasparente, come libmpv sotto WebView2 su Windows: gli eventi hanno i nomi delle proprietà di
 * mpv, così la pagina usa lo stesso codice. Gestisce anche il tasto Indietro del telecomando,
 * i player esterni e le informazioni sul dispositivo.
 */
@OptIn(markerClass = [UnstableApi::class])
@TauriPlugin
class NativePlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    // per MainActivity, che vede i tasti prima della WebView
    var instance: NativePlugin? = null
  }

  init {
    instance = this
  }

  /** OK del telecomando su un campo di testo non arriva alla pagina (lo tiene la WebView):
   *  la si avvisa, e lei decide se aprire la tastiera (09e-tv.js). */
  fun onSelectKey() = sendKey("Select")

  private val main = Handler(Looper.getMainLooper())
  private var events: Channel? = null
  private var webView: WebView? = null

  private var view: PlayerView? = null
  private var player: ExoPlayer? = null
  // live, cache e uscita audio con cui è stato creato il player
  private var playerConfig = ""
  private var loaded = false
  private var live = false
  private var volume = 1f
  private var muted = false
  private var everReady = false
  private var restartPending = false
  private var buffering = false
  private var lastDuration = -1L
  // id in stile mpv (1, 2, … per tipo) -> traccia di ExoPlayer
  private val audioTracks = mutableMapOf<Int, Pair<Tracks.Group, Int>>()
  private val textTracks = mutableMapOf<Int, Pair<Tracks.Group, Int>>()

  private val ticker = object : Runnable {
    override fun run() {
      val p = player ?: return
      if (loaded) {
        emit("time-pos", (p.currentPosition / 1000.0).toString())
        val ahead = (p.bufferedPosition - p.currentPosition).coerceAtLeast(0)
        emit("demuxer-cache-duration", (ahead / 1000.0).toString())
        val d = p.duration
        if (!live && d != C.TIME_UNSET && d > 0 && d != lastDuration) {
          lastDuration = d
          emit("duration", (d / 1000.0).toString())
        }
      }
      main.postDelayed(this, 500)
    }
  }

  override fun load(webView: WebView) {
    this.webView = webView
    main.post {
      webView.setBackgroundColor(Color.TRANSPARENT)
      // la pagina si adatta alla larghezza scelta nel meta viewport (01-base.js), senza zoom
      webView.settings.useWideViewPort = true
      webView.settings.loadWithOverviewMode = true
      webView.settings.setSupportZoom(false)
      webView.settings.builtInZoomControls = false
      webView.settings.displayZoomControls = false
      webView.isFocusable = true
      webView.isFocusableInTouchMode = true
      webView.requestFocus()
      hideSystemBars()
    }
    // dopo quelli di Tauri: il tasto Indietro lo decide la pagina (Esc), non la cronologia
    (activity as AppCompatActivity).onBackPressedDispatcher.addCallback(
      activity,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (events == null) activity.moveTaskToBack(true) else sendKey("Back")
        }
      },
    )
  }

  // ------------------------------------------------------------------ canale degli eventi

  @Command
  fun watch(invoke: Invoke) {
    events = invoke.parseArgs(WatchArgs::class.java).channel
    invoke.resolve()
  }

  private fun emit(name: String, value: Any?) {
    val ch = events ?: return
    val msg = JSObject()
    msg.put("kind", "mpv")
    msg.put("name", name)
    msg.put("value", value ?: JSONObject.NULL)
    try { ch.send(msg) } catch (_: Exception) { }
  }

  private fun sendKey(key: String) {
    val ch = events ?: return
    val msg = JSObject()
    msg.put("kind", "key")
    msg.put("key", key)
    try { ch.send(msg) } catch (_: Exception) { }
  }

  // ------------------------------------------------------------------ dispositivo

  @Command
  fun info(invoke: Invoke) {
    val ui = activity.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
    val pm = activity.packageManager
    val tv = ui.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
      pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
    val name = try {
      Settings.Global.getString(activity.contentResolver, "device_name")
    } catch (_: Exception) { null }
    val out = JSObject()
    out.put("tv", tv)
    out.put("touch", pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN))
    out.put("device", if (name.isNullOrBlank()) "${Build.MANUFACTURER} ${Build.MODEL}" else name)
    invoke.resolve(out)
  }

  @Command
  fun openUrl(invoke: Invoke) {
    val args = invoke.parseArgs(UrlArgs::class.java)
    main.post {
      try {
        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url)))
        invoke.resolve()
      } catch (e: ActivityNotFoundException) {
        invoke.reject("Nessun browser installato per aprire il link")
      }
    }
  }

  /** Telefono: orizzontale bloccato per film ed episodi, altrimenti libero (come in manifest). */
  @Command
  fun orientation(invoke: Invoke) {
    val args = invoke.parseArgs(OrientationArgs::class.java)
    main.post {
      activity.requestedOrientation = if (args.landscape) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      else ActivityInfo.SCREEN_ORIENTATION_FULL_USER
      invoke.resolve()
    }
  }

  /** Tastiera a schermo per il campo attivo della pagina (sulla TV la apre OK, non lo spostamento). */
  @Command
  fun keyboard(invoke: Invoke) {
    main.post {
      val wv = webView
      if (wv != null) {
        val imm = activity.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(wv, 0)
      }
      invoke.resolve()
    }
  }

  /** Indietro al primo livello: l'app va in secondo piano (come Home), lo stream si ferma. */
  @Command
  fun leave(invoke: Invoke) {
    main.post {
      activity.moveTaskToBack(true)
      invoke.resolve()
    }
  }

  @Command
  fun openExternal(invoke: Invoke) {
    val args = invoke.parseArgs(ExternalArgs::class.java)
    main.post {
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(Uri.parse(args.url), "video/*")
        putExtra("title", args.title)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      val vlc = "org.videolan.vlc"
      val usePref = args.prefer == "vlc" && installed(vlc)
      try {
        if (usePref) {
          intent.setPackage(vlc)
          activity.startActivity(intent)
          invoke.resolveObject("VLC")
        } else {
          activity.startActivity(Intent.createChooser(intent, args.title.ifBlank { "Apri con" }))
          invoke.resolveObject("player esterno")
        }
        stopPlayback()
      } catch (e: ActivityNotFoundException) {
        invoke.reject("Nessun player video installato. Installa VLC o MX Player dal Play Store.")
      }
    }
  }

  private fun installed(pkg: String): Boolean = try {
    activity.packageManager.getPackageInfo(pkg, 0)
    true
  } catch (_: PackageManager.NameNotFoundException) {
    false
  }

  @Suppress("DEPRECATION")
  private fun hideSystemBars() {
    val window = activity.window
    WindowCompat.setDecorFitsSystemWindows(window, true)
    val ctl = WindowInsetsControllerCompat(window, window.decorView)
    ctl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    ctl.hide(WindowInsetsCompat.Type.systemBars())
  }

  override fun onResume(activity: AppCompatActivity) {
    main.post { hideSystemBars() }
  }

  override fun onPause(activity: AppCompatActivity) {
    // in secondo piano niente audio: si mette in pausa (il live riparte con R o riaprendo)
    val p = player ?: return
    if (loaded && p.playWhenReady) p.playWhenReady = false
  }

  override fun onDestroy(activity: AppCompatActivity) {
    main.removeCallbacks(ticker)
    player?.release()
    player = null
  }

  // ------------------------------------------------------------------ player

  private fun ensureView(): PlayerView {
    view?.let { return it }
    val root = activity.findViewById<ViewGroup>(android.R.id.content)
    val v = PlayerView(activity).apply {
      useController = false
      resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
      setShutterBackgroundColor(Color.BLACK)
      setBackgroundColor(Color.BLACK)
      isFocusable = false
      isFocusableInTouchMode = false
      isClickable = false
      visibility = android.view.View.GONE
      subtitleView?.setApplyEmbeddedStyles(true)
      subtitleView?.setFractionalTextSize(0.0533f * 1.15f)
    }
    // sotto la WebView: la pagina è trasparente sul rettangolo del player
    root.addView(v, 0, FrameLayout.LayoutParams(1, 1))
    view = v
    return v
  }

  private fun buildPlayer(args: LoadArgs): ExoPlayer {
    // live 0,5-7 s (preset di latenza), film fino a 60 s
    val cacheMs = ((args.cacheSecs ?: if (args.live) 2.0 else 30.0) * 1000).toInt()
      .coerceIn(500, if (args.live) 7000 else 60000)
    val config = "${args.live}|$cacheMs|${args.audio}|${args.userAgent}"
    player?.let { if (config == playerConfig) return it }
    player?.release()
    playerConfig = config

    val passthrough = args.audio == "orig"
    val renderers = object : DefaultRenderersFactory(activity) {
      override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
      ): AudioSink {
        val b = DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
        // "stereo": niente bitstream AC3/DTS all'amplificatore, tutto decodificato in PCM
        @Suppress("DEPRECATION")
        if (!passthrough) b.setAudioCapabilities(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
        return b.build()
      }
    }
      // decoder di sistema prima, ffmpeg (AC3, E-AC3, DTS, MP2…) dove manca
      .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
      .setEnableDecoderFallback(true)

    val http = DefaultHttpDataSource.Factory()
      .setUserAgent(args.userAgent.ifBlank { "IPTVSmartersPro" })
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15000)
      .setReadTimeoutMs(20000)
    val extractors = DefaultExtractorsFactory()
      .setTsExtractorFlags(
        DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or
          DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS,
      )
      .setConstantBitrateSeekingEnabled(true)
    val sources = DefaultMediaSourceFactory(http, extractors)

    val load = if (args.live) {
      // live: si parte con 1-2 s di buffer (preset di latenza), poi si tiene un margine
      DefaultLoadControl.Builder()
        .setBufferDurationsMs(maxOf(cacheMs * 4, 8000), 30000, cacheMs, cacheMs * 2)
        .setPrioritizeTimeOverSizeThresholds(true)
        .build()
    } else {
      DefaultLoadControl.Builder()
        .setBufferDurationsMs(maxOf(cacheMs, 15000), maxOf(cacheMs * 2, 50000), 1500, 3000)
        .build()
    }

    val p = ExoPlayer.Builder(activity, renderers)
      .setMediaSourceFactory(sources)
      .setLoadControl(load)
      .build()
    p.addListener(listener)
    p.addAnalyticsListener(analytics)
    ensureView().player = p
    player = p
    return p
  }

  @Command
  fun load(invoke: Invoke) {
    val args = invoke.parseArgs(LoadArgs::class.java)
    main.post {
      try {
        val p = buildPlayer(args)
        live = args.live
        loaded = true
        everReady = false
        restartPending = true
        buffering = true
        lastDuration = -1
        audioTracks.clear(); textTracks.clear()
        volume = ((args.volume ?: (volume * 100.0)) / 100.0).toFloat().coerceIn(0f, 1f)
        args.mute?.let { muted = it }
        p.volume = if (muted) 0f else volume

        val params = p.trackSelectionParameters.buildUpon()
          .clearOverrides()
          .setPreferredAudioLanguages(*langs(args.alang))
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, args.slang.isBlank())
        if (args.slang.isNotBlank()) params.setPreferredTextLanguages(*langs(args.slang))
        p.trackSelectionParameters = params.build()

        val item = MediaItem.Builder().setUri(args.url)
        if (args.url.substringBefore('?').lowercase().endsWith(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8)
        val startMs = if (!args.live) ((args.start ?: 0.0) * 1000).toLong() else 0L
        p.setMediaItem(item.build(), startMs)
        p.playWhenReady = true
        p.prepare()
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        main.removeCallbacks(ticker)
        main.post(ticker)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: e.toString())
      }
    }
  }

  // "ita,it" di mpv -> ["ita", "it"]
  private fun langs(s: String): Array<String> =
    s.split(',', ' ').map { it.trim() }.filter { it.isNotEmpty() }.toTypedArray()

  private fun stopPlayback() {
    loaded = false
    main.removeCallbacks(ticker)
    player?.stop()
    player?.clearMediaItems()
    view?.visibility = android.view.View.GONE
    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }

  @Command
  fun stop(invoke: Invoke) {
    main.post {
      stopPlayback()
      invoke.resolve()
    }
  }

  @Command
  fun set(invoke: Invoke) {
    val args = invoke.parseArgs(SetArgs::class.java)
    main.post {
      val p = player
      if (p == null) { invoke.resolve(); return@post }
      when (args.name) {
        "pause" -> {
          p.playWhenReady = args.value != "yes"
          // dopo un errore il player resta fermo: ripartire richiede un nuovo prepare
          if (p.playWhenReady && p.playbackState == Player.STATE_IDLE) p.prepare()
        }
        "volume" -> {
          volume = ((args.value.toDoubleOrNull() ?: 100.0) / 100.0).toFloat().coerceIn(0f, 1f)
          p.volume = if (muted) 0f else volume
        }
        "mute" -> {
          muted = args.value == "yes"
          p.volume = if (muted) 0f else volume
        }
        "aid" -> selectTrack(p, C.TRACK_TYPE_AUDIO, audioTracks[args.value.toIntOrNull() ?: -1])
        "sid" -> {
          val t = textTracks[args.value.toIntOrNull() ?: -1]
          if (args.value == "no" || t == null) {
            p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
              .clearOverridesOfType(C.TRACK_TYPE_TEXT)
              .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
              .build()
            emit("sid", "no")
          } else {
            selectTrack(p, C.TRACK_TYPE_TEXT, t)
          }
        }
      }
      invoke.resolve()
    }
  }

  private fun selectTrack(p: ExoPlayer, type: Int, t: Pair<Tracks.Group, Int>?) {
    t ?: return
    p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
      .setTrackTypeDisabled(type, false)
      .setOverrideForType(TrackSelectionOverride(t.first.mediaTrackGroup, t.second))
      .build()
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.parseArgs(SeekArgs::class.java)
    main.post {
      player?.let {
        restartPending = true
        it.seekTo((args.secs * 1000).toLong())
      }
      invoke.resolve()
    }
  }

  @Command
  fun rect(invoke: Invoke) {
    val args = invoke.parseArgs(RectArgs::class.java)
    main.post {
      val v = if (args.visible) ensureView() else view
      if (v != null) {
        val wv = webView
        if (args.visible && loaded && wv != null && args.vw > 0) {
          // px CSS -> pixel della WebView (pagina scalata dal viewport)
          val k = wv.width / args.vw
          val lp = FrameLayout.LayoutParams(
            Math.round(args.w * k).toInt().coerceAtLeast(1),
            Math.round(args.h * k).toInt().coerceAtLeast(1),
          )
          lp.leftMargin = Math.round(args.x * k).toInt() + wv.left
          lp.topMargin = Math.round(args.y * k).toInt() + wv.top
          v.layoutParams = lp
          v.visibility = android.view.View.VISIBLE
        } else {
          v.visibility = android.view.View.GONE
        }
      }
      invoke.resolve()
    }
  }

  // ------------------------------------------------------------------ eventi di ExoPlayer

  private val listener = object : Player.Listener {
    override fun onPlaybackStateChanged(state: Int) {
      if (!loaded) return
      when (state) {
        Player.STATE_BUFFERING -> {
          if (everReady && !buffering) emit("paused-for-cache", "yes")
          buffering = true
        }
        Player.STATE_READY -> {
          if (buffering && everReady) emit("paused-for-cache", "no")
          buffering = false
          if (restartPending) {
            restartPending = false
            emit("playback-restart", null)
          }
          everReady = true
        }
        Player.STATE_ENDED -> {
          emit("end-file", JSObject().apply { put("reason", "eof"); put("error", "") })
        }
        else -> Unit
      }
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      if (loaded) emit("pause", if (playWhenReady) "no" else "yes")
      if (playWhenReady) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onPlayerError(error: PlaybackException) {
      if (!loaded) return
      val cause = error.cause?.message
      val msg = if (cause.isNullOrBlank()) error.errorCodeName else "${error.errorCodeName}: $cause"
      emit("end-file", JSObject().apply { put("reason", "error"); put("error", msg) })
    }

    override fun onVideoSizeChanged(size: VideoSize) {
      if (size.width > 0) emit("width", size.width.toString())
      if (size.height > 0) emit("height", size.height.toString())
    }

    override fun onTracksChanged(tracks: Tracks) {
      if (!loaded) return
      audioTracks.clear(); textTracks.clear()
      val list = JSONArray()
      var aid = 0; var sid = 0; var na = 0; var ns = 0
      for (g in tracks.groups) {
        val type = when (g.type) {
          C.TRACK_TYPE_AUDIO -> "audio"
          C.TRACK_TYPE_TEXT -> "sub"
          else -> continue
        }
        for (i in 0 until g.length) {
          val f = g.getTrackFormat(i)
          val id = if (type == "audio") ++na else ++ns
          if (type == "audio") audioTracks[id] = g to i else textTracks[id] = g to i
          val selected = g.isTrackSelected(i)
          if (selected) { if (type == "audio") aid = id else sid = id }
          list.put(JSONObject().apply {
            put("id", id)
            put("type", type)
            put("lang", f.language ?: "")
            put("title", f.label ?: "")
            put("codec", codecName(f))
            put("selected", selected)
            put("default", f.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0)
            put("forced", f.selectionFlags and C.SELECTION_FLAG_FORCED != 0)
            if (type == "audio" && f.channelCount != Format.NO_VALUE) put("demux-channel-count", f.channelCount)
          })
        }
      }
      emit("track-list", list.toString())
      emit("aid", aid.toString())
      emit("sid", if (sid > 0) sid.toString() else "no")
    }
  }

  private val analytics = object : AnalyticsListener {
    override fun onVideoDecoderInitialized(
      eventTime: AnalyticsListener.EventTime,
      decoderName: String,
      initializedTimestampMs: Long,
      initializationDurationMs: Long,
    ) {
      val sw = decoderName.startsWith("c2.android.") || decoderName.startsWith("OMX.google.")
      emit("hwdec-current", if (sw) "no" else "mediacodec")
    }

    override fun onVideoInputFormatChanged(
      eventTime: AnalyticsListener.EventTime,
      format: Format,
      decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?,
    ) {
      emit("video-format", codecName(format))
    }

    override fun onAudioInputFormatChanged(
      eventTime: AnalyticsListener.EventTime,
      format: Format,
      decoderReuseEvaluation: androidx.media3.exoplayer.DecoderReuseEvaluation?,
    ) {
      emit("audio-codec-name", codecName(format))
      if (format.channelCount != Format.NO_VALUE) emit("audio-params/channel-count", format.channelCount.toString())
    }
  }

  // nomi dei codec come in mpv/ffmpeg, per le etichette delle tracce e il pannello info
  @SuppressLint("DefaultLocale")
  private fun codecName(f: Format): String = when (f.sampleMimeType) {
    MimeTypes.VIDEO_H264 -> "h264"
    MimeTypes.VIDEO_H265 -> "hevc"
    MimeTypes.VIDEO_MPEG2 -> "mpeg2video"
    MimeTypes.VIDEO_AV1 -> "av1"
    MimeTypes.VIDEO_VP9 -> "vp9"
    MimeTypes.VIDEO_DOLBY_VISION -> "dvhe"
    MimeTypes.AUDIO_AAC -> "aac"
    MimeTypes.AUDIO_AC3 -> "ac3"
    MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> "eac3"
    MimeTypes.AUDIO_DTS -> "dts"
    MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_DTS_X -> "dts-hd"
    MimeTypes.AUDIO_TRUEHD -> "truehd"
    MimeTypes.AUDIO_MPEG -> "mp3"
    MimeTypes.AUDIO_MPEG_L2 -> "mp2"
    MimeTypes.AUDIO_OPUS -> "opus"
    MimeTypes.AUDIO_FLAC -> "flac"
    MimeTypes.APPLICATION_SUBRIP -> "subrip"
    MimeTypes.TEXT_VTT -> "webvtt"
    MimeTypes.TEXT_SSA -> "ass"
    MimeTypes.APPLICATION_DVBSUBS -> "dvb_subtitle"
    MimeTypes.APPLICATION_PGS -> "hdmv_pgs_subtitle"
    MimeTypes.APPLICATION_CEA608, MimeTypes.APPLICATION_CEA708 -> "eia_608"
    MimeTypes.APPLICATION_TX3G -> "mov_text"
    else -> (f.codecs ?: f.sampleMimeType ?: "").substringAfter('/').lowercase()
  }
}
