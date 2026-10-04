# E-badge Web BLE PoC

KEIYO / Beambox系 E-badge向けの静的Web Bluetooth実験アプリです。

## 配置

`index.html`, `app.js`, `app.css` を同じディレクトリへ置くだけです。すべて相対パスなので、

- `https://example.com/`
- `https://example.com/path/to/app/`
- `https://sub.example.com/a/b/c/`

など任意のFQDN・パス深さで動作します。

Web BluetoothのためHTTPS（またはlocalhost）が必要です。

## MACクエリ

例:

`https://example.com/path/to/app/?mac=deadbeefcafe`

Web Bluetooth APIはBluetoothデバイスの実MACアドレスをWebページへ公開しません。そのため次の方式です。

1. 初回は「デバイスを選択」でユーザーが対象バッジを選ぶ
2. URLに`mac=`が指定されていれば、その値とブラウザ固有の`BluetoothDevice.id`をlocalStorageへ対応付ける
3. 次回以降は「優先デバイスに接続」で`navigator.bluetooth.getDevices()`から対応する許可済みデバイスを優先して接続

この対応付けは同一origin・同一ブラウザプロファイル内でのみ有効です。

## 現在のBLE仕様

- Advertised name: `E-badge`
- Advertised service: `0000af30-0000-1000-8000-00805f9b34fb`
- GATT service: `000001f0-0000-1000-8000-00805f9b34fb`
- TX: `000001f1-0000-1000-8000-00805f9b34fb` / Write Without Response
- RX: `000001f2-0000-1000-8000-00805f9b34fb` / Notify

静止画は368x368 JPEGへ変換し、IMBヘッダを付けて446-byte payloadへ分割、`F1 06`フレームとして送信します。

## デバッグ

デバッグタブで送受信ログをコピー・保存できます。実機検証時にこのログをそのまま共有すると解析しやすくなります。

## 注意

PoCです。IMBヘッダの一部フィールドは実機ログから観測した固定値を使用しています。またWeb Bluetooth実装ごとにWrite Without Responseのキュー挙動が異なる可能性があるため、初期値12msのチャンク間隔を設定しています。
