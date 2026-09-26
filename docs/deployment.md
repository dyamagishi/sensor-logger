# NanoPi R5S (OpenWrt) への導入・更新

## 動作構成

ARM64 Linux・OpenWrt (procd)・BLE対応USBアダプターを使います。NanoPi R5S、OpenWrt 25.12.5 / kernel 6.12.94、CSR8510 A10でHCI直接受信を確認しています。

OpenWrtにはsystemd/BlueZが無いため、受信に必要なhci0の初期化はアプリ自身が行います。`rust/ble.rs` はHCI rawソケットを開いた後に `HCIDEVUP` ioctlでアダプタを電源投入し、`receiver = "hci"` で広告を受信します。専用アダプターで別の探索や接続を同時に行わないでください。

以下の `nanopi-r5s-b` はSSH設定の接続先例です（NanoPi R5S の LAN-B 側 `192.168.53.1`）。自分の機器に置き換えてください。管理はmacOSがLAN-Bにいる前提です。

## 必要パッケージ

```sh
ssh nanopi-r5s-b 'apk update && apk add kmod-bluetooth kmod-btusb'
```

ドングル挿入で `btusb` が自動ロードされ、`/sys/class/bluetooth/hci0` が現れます。出ない場合は `modprobe btusb` か挿抜を試します。BlueZ (`bluez-daemon`/`bluez-utils`) は不要です。

## 初回導入

1. Macで `config/sensors.toml` を設定例から作成し、`npm run build` と `sh scripts/build-rust.sh` を実行します。`sensors.toml` の `host` は待受させたいLANのルーターIP（例: LAN-Bのみなら `192.168.53.1`）にします。
2. 配置先を用意します。

```sh
ssh nanopi-r5s-b 'mkdir -p /opt/home-sensors/config /etc/home-sensors /tmp/home-sensors'
```

3. バイナリ、`dist/`、センサー設定を転送し、以下の場所に配置します。macOSの `scp` はSFTPを使うため `-O` を付けます。

| ローカル | 本体 |
| --- | --- |
| `target/aarch64-unknown-linux-musl/release/home-sensors` | `/opt/home-sensors/home-sensors`（0755） |
| `dist/` | `/opt/home-sensors/dist/` |
| `config/sensors.toml` | `/opt/home-sensors/config/sensors.toml` |
| `deploy/home-sensors.init` | `/etc/init.d/home-sensors`（0755） |

```sh
scp -O target/aarch64-unknown-linux-musl/release/home-sensors nanopi-r5s-b:/opt/home-sensors/home-sensors
scp -O -r dist nanopi-r5s-b:/opt/home-sensors/
scp -O config/sensors.toml nanopi-r5s-b:/opt/home-sensors/config/sensors.toml
scp -O deploy/home-sensors.init nanopi-r5s-b:/etc/init.d/home-sensors
```

4. `config/home-sensors.env.example` を元に `/etc/home-sensors.env` を作成します。root所有・0600にし、必要ならクラウドURLと書込・読取トークンを設定します。ローカルのみの場合もファイルは作成します。

5. サービスを有効化します。

```sh
ssh nanopi-r5s-b 'chmod 755 /etc/init.d/home-sensors /opt/home-sensors/home-sensors && /etc/init.d/home-sensors enable && /etc/init.d/home-sensors start'
```

`/tmp/home-sensors` はinitスクリプトが作成します。Web画面は `http://<host>:8080/` です。

6. LAN-Bのみに公開する場合、LAN-AホストがルーターのLAN-Bアドレス `:8080` へ到達できるため、firewallで遮断します。

```sh
ssh nanopi-r5s-b 'uci add firewall rule; uci set firewall.@rule[-1].name=Reject-Sensors-LAN-A; \
  uci set firewall.@rule[-1].src=lan; uci set firewall.@rule[-1].proto=tcp; \
  uci set firewall.@rule[-1].dest_port=8080; uci set firewall.@rule[-1].target=REJECT; \
  uci commit firewall; /etc/init.d/firewall reload'
```

7. ファームウェア更新で残すため `/etc/sysupgrade.conf` に追記します。

```
/opt/home-sensors/
/etc/home-sensors/
/etc/home-sensors.env
/etc/init.d/home-sensors
```

## 更新

再起動でRAM上の未送信記録が失われるため、`/api/status` の `cloud.pending` が0になった直後に更新します。

1. Macでテストとビルドを実行します。

```sh
cargo test --locked
sh scripts/build-rust.sh
```

2. 新バイナリを一時配置し、`--version` で実行できることを確認します。

```sh
scp -O target/aarch64-unknown-linux-musl/release/home-sensors nanopi-r5s-b:/opt/home-sensors/home-sensors.new
ssh nanopi-r5s-b 'chmod 755 /opt/home-sensors/home-sensors.new && /opt/home-sensors/home-sensors.new --version'
```

3. 現行バイナリを `home-sensors.previous`、initスクリプトを `home-sensors.init.previous` として保存します。

4. サービス停止、新バイナリの配置、必要ならinit・画面の更新、起動の順に実施します。設定・環境変数・追加登録ファイルは引き継ぎます。

```sh
ssh nanopi-r5s-b 'cp /opt/home-sensors/home-sensors /opt/home-sensors/home-sensors.previous && \
  cp /etc/init.d/home-sensors /opt/home-sensors/home-sensors.init.previous && \
  /etc/init.d/home-sensors stop && \
  mv /opt/home-sensors/home-sensors.new /opt/home-sensors/home-sensors && \
  /etc/init.d/home-sensors start'
```

5. `events` / `observed_at` の増加、分境界後の `history_points` 増加、毎時送信後の `last_sent` 更新を確認します。

```sh
ssh nanopi-r5s-b '/etc/init.d/home-sensors status; logread | tail -20'
curl -fsS http://192.168.53.1:8080/api/status
```

不具合時は停止して `.previous` のバイナリ・initを戻して再起動します。

## 実装と検証

- `rust/ble.rs`: HCI広告・スキャン応答の併合、温湿度・CO₂解析、HCIDEVUPによるアダプタ初期化、再接続・探索。
- `rust/store.rs`: 毎分記録、24時間のRAM履歴・送信キュー。
- `rust/cloud.rs`: 毎時送信、受領確認、登録同期、履歴キャッシュ・RAM併合。
- `rust/registry.rs`: アドレスからのID生成、0600設定の原子的保存。
- `rust/main.rs`: HTTP API、同一Origin・専用ヘッダー検査、32 KiB入力上限、エラーログ。

Rustテストは広告解析・切断パケット・不正値、分の繰越禁止、期限切れ、探索・二重登録・CSRF・設定保存、送信受領不一致時の保持・再試行・1,000件分割、履歴キャッシュと部分RAMの併合を確認します。HCIソケットはLinux実機で確認してください。
