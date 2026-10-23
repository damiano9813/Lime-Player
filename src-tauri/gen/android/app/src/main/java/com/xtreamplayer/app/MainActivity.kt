package com.xtreamplayer.app

import android.view.KeyEvent

// Le barre di sistema le nasconde NativePlugin: l'interfaccia è a tutto schermo come sul desktop.
class MainActivity : TauriActivity() {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.action == KeyEvent.ACTION_UP &&
      (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER || event.keyCode == KeyEvent.KEYCODE_ENTER)
    ) NativePlugin.instance?.onSelectKey()
    return super.dispatchKeyEvent(event)
  }
}
