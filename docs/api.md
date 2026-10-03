# 本体 HTTP API

NanoPi R5S 上の収集サービスが提供するローカルHTTP APIです。`config/sensors.toml` の `host`/`port`（既定は LAN-B の `192.168.53.1:8080`）で待ち受けます。

- **LAN-B 内限定**。LAN-A は firewall で遮断、WAN からは到達できません。
- **ローカルAPIに認証はありません**（信頼できるLAN前提）。クラウド用トークンは応答に含めません。
- クラウド（Cloudflare Workers + D1）への送信・履歴取得は本体が内部的に行います。外部からそれを操作するAPIはありません。

## 共通仕様

| 項目 | 内容 |
|---|---|
| ベースURL | `http://<host>:<port>`（例 `http://192.168.53.1:8080`） |
| リクエストボディ上限 | 32,768 bytes（32 KiB） |
| 応答ヘッダ | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` |
| エラー形式 | `{"error":"<message>"}` と対応するHTTPステータス |

**書き込み（POST）のガード** — GET/HEAD/OPTIONS はそのまま許可されます。POST は次をすべて満たす必要があり、満たさない場合は `403` を返します。

1. `Content-Type: application/json`（`;` 以降のパラメータは無視）
2. ヘッダ `x-home-sensors: 1`
3. `Origin` ヘッダが無い、または `http://<Host>` と完全一致（`<Host>` は `Host` ヘッダの値）

ブラウザの画面（同一Origin）以外、たとえば `curl` は `Origin` を送らなければ上記2ヘッダだけで通ります。

---

## `GET /api/status`

現在値と稼働状態を返します。

```json
{
  "now": 1790439127,
  "uptime_seconds": 346,
  "history_points": 17,
  "sensors": [
    {
      "id": "co2-meter",
      "sensor_id": "co2-meter",
      "name": "CO₂センサー",
      "kind": "co2",
      "events": 57,
      "temperature": 26.6,
      "humidity": 60.0,
      "co2": 1503.0,
      "battery": 100.0,
      "rssi": -74.0,
      "observed_at": 1790439126,
      "stale": false
    }
  ],
  "collector": { "state": "scanning", "error": null, "last_event": 1790439126 },
  "cloud": {
    "state": "buffering",
    "error": null,
    "last_sent": null,
    "pending": 17,
    "dropped": 0,
    "next_send_at": 1790442002,
    "upload_seconds": 3600,
    "upload_requests": 0
  }
}
```

- `sensors[]`: `id`=登録ID、`sensor_id`=クラウド用ID（`id` と同一のことが多い）、`kind` は `meter`/`co2`。`stale` は直近180秒の受信が無い場合 `true`。`cloud_synced` は追加登録同期の状態（GUI追加分のみ付与）。未取得の測定値は `null`。
- `collector.state`: `scanning`（正常受信）/`connecting`/`error`/`disabled`。`last_event` は最後に広告を解釈できた時刻。
- `cloud.state`: `unconfigured`（URL空）/`buffering`（送信待ち）/`online`/`offline`。`pending`=未送信件数、`dropped`=24時間の保持期限切れ件数、`next_send_at`=次回送信予定時刻。

## `GET /api/history`

登録センサーの履歴を返します。クラウドから取得し、未送信分のRAM記録やキャッシュと併合します。

| クエリ | 必須 | 内容 |
|---|---|---|
| `sensor_id` | ○ | 登録済みのID |
| `days` | | `1`/`7`/`30`/`365`（省略時 `1`）。それ以外は `400` |

```sh
curl -s 'http://192.168.53.1:8080/api/history?sensor_id=co2-meter&days=1'
```

```json
{
  "available_since": 1790438760,
  "bucket_seconds": 60,
  "source": "memory",
  "cloud_error": null,
  "from": 1790352780,
  "to": 1790439180,
  "samples": [
    {
      "minute": 1790438760,
      "sample_count": 1,
      "temperature": 26.6, "temperature_min": 26.6, "temperature_max": 26.6,
      "humidity": 60.0, "humidity_min": 60.0, "humidity_max": 60.0,
      "co2": 1503.0, "co2_min": 1503.0, "co2_max": 1503.0
    }
  ]
}
```

- `source`: `cloud`（クラウド取得成功）/`cached`（キャッシュ利用、`cloud_error` あり）/`memory`（本体RAMのみ）。
- `bucket_seconds`: 通常 `60`（1分）、`days=365` は `3600`（時間集計）。`samples[]` の `*_min`/`*_max` と `sample_count` は集計値。「その分の実受信が無い」場合は補完しません。

## `GET /api/discovery`

探索中・直近180秒に受信した未登録/登録済みの候補機器を返します。

```json
{
  "collector_state": "scanning",
  "scanning": true,
  "until": 1790439247,
  "devices": [
    {
      "address": "DB:C0:B3:6A:D9:43",
      "name": "温湿度計",
      "kind": "meter",
      "observed_at": 1790439126,
      "temperature": 25.8, "humidity": 66.0, "co2": null, "battery": 100.0, "rssi": -76.0,
      "registered": true,
      "registered_name": "温湿度計1"
    }
  ]
}
```

- `scanning`/`until`: 能動探索中かと終了予定時刻。`registered`/`registered_name` は登録有無。

## `POST /api/discovery`

能動探索を開始/停止します。

```sh
curl -s -X POST http://192.168.53.1:8080/api/discovery \
  -H 'Content-Type: application/json' -H 'x-home-sensors: 1' \
  -d '{"active":true}'
```

- `{"active":true}` または `active` 省略で120秒探索、`{"active":false}` で停止。応答は `GET /api/discovery` と同形式。
- `collector.state` が `disabled` の場合は `503`。

## `POST /api/sensors`

探索で見つかった機器を登録します。設定は本体側に原子的に保存されます。

```sh
curl -s -X POST http://192.168.53.1:8080/api/sensors \
  -H 'Content-Type: application/json' -H 'x-home-sensors: 1' \
  -d '{"address":"DB:C0:B3:6A:D9:43","name":"温湿度計1"}'
```

- 成功: `201` `{"sensor":{"id","name","kind",...},"cloud_pending":true}`（応答からは `address` を除く）。`cloud_pending` はクラウド設定済みか（次回の毎時送信前に同期）。
- `400`: 機器未選択・直近の電波を受信できない・表示名が1〜40文字でない。
- `409`: 登録済み、または上限32台。
- `503`: 登録情報を保存できない（追加は行わない）。

## 例: 定期取得

```sh
# 現在値（jqで要約）
curl -s http://192.168.53.1:8080/api/status \
  | jq '.sensors[] | {id, temperature, humidity, co2, battery, stale}'

# 探索開始 → 数秒待って候補一覧
curl -s -X POST http://192.168.53.1:8080/api/discovery \
  -H 'Content-Type: application/json' -H 'x-home-sensors: 1' -d '{"active":true}'
curl -s http://192.168.53.1:8080/api/discovery | jq '.devices[] | {address, name, registered}'
```

> 本体へは `192.168.53.1` で到達します。SSH側の `localhost` では待受していない点に注意してください。

## Hue照明API

セットアップは[Hueの管理者CLI](hue.md)を使います。Hueの認証情報は応答に含めません。`/api/status`の`hue`に接続状態・最終取得時刻・登録デバイスを追加し、`cloud.pending`と`dropped`はセンサーと照明の合計になります。

### `GET /api/hue/devices`

定期取得した個々のデバイス一覧を返します。GETでBridgeへの追加取得は行いません。

- `state`: `unconfigured` / `connecting` / `online` / `offline`
- `devices`: Bridge上の候補。`id`, `name`, `selected`, `present`, `outputs[]`
- `archive`: 過去に登録し、現在選択していないデバイス
- `outputs[]`: 出力ID・名前・対応項目（`dimming`, `color`, `temperature`のmirek範囲）、`values`、`available`, `connectivity`, `observed_at`
- `values`: `on`, `brightness`, `mirek`, `x`, `y`, `color_mode`。非対応・無効な値は`null`。取得不可時の現在値は最後の確認値で、履歴の欠測とは区別します。

### `POST /api/hue/devices`

```json
{"device_id":"hue-00000000000000000000000000000001","selected":true}
```

選択を原子的に保存します。解除は`selected:false`。過去履歴は削除しません。選択中は最大128デバイス、登録出力はアーカイブを含め最大512。成功は`200 {"ok":true}`、保存失敗は`503`です。

### `POST /api/hue/control`

```json
{"light_id":"hue-00000000000000000000000000000002","brightness":60}
```

操作は次の任意項目を指定します。出力IDは一覧から取得します。

| 項目 | 指定 |
|---|---|
| `on` | boolean、点灯・消灯 |
| `brightness` | 0〜100%、対応機器のみ。0は消灯ではない |
| `mirek` | 機器の色温度範囲内の整数。Kelvin = 1,000,000 / mirek |
| `xy` | CIE xyの`[x,y]`。機器の色域が取得できれば範囲内へ補正 |

明るさ・色温度・色の変更は点灯も指示します。色温度と色の同時指定、消灯と調整の同時指定、非対応項目・不正値は`400`です。登録外出力は`404`、確認・操作中は`409`、状態取得不可は`503`、操作または再取得失敗は`502`。成功は再取得した`hue`状態を返します。操作後の取得は履歴へ追加しません。

### `GET /api/hue/history?light_id=…&days=1`

`days`は`1`/`7`/`30`/`365`、省略時は1。解除した照明も参照できます。`samples`, `bucket_seconds`, `from`, `to`, `source`, `cloud_error`を返します。

- 分記録：`minute`, `observed_at`, `available`, `connectivity`, `on`, `brightness`, `mirek`, `x`, `y`, `color_mode`。取得不可なら状態値は`null`。
- 時間集計：`minute`, `on_fraction`（0〜1）, `brightness`, `brightness_min`, `brightness_max`, `mirek`, `x`, `y`, `available_count`, `unavailable_count`, `sample_count`。
- クラウド履歴とRAMの記録を併合します。不完全なRAM集計で既存のクラウド時間集計を上書きしません。

### クラウド側

`/api/v1/hue/lights`と`/api/v1/hue/samples`へのPOSTは`INGEST_TOKEN`、`/api/v1/hue/history`へのGETは`READ_TOKEN`を必要とします。センサーと同じ受領確認・最大1,000件分割・同一出力／分の再送重複排除を使います。Hue専用テーブルは`0003_hue.sql`で追加します。
