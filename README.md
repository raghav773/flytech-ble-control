# Fly Tech BLE Control

A small Web Bluetooth app for the Fly Tech Services BLE take-home project. It connects to a simulated BLE peripheral, reads and monitors a status characteristic, writes a control byte from the UI, and shows the current BLE connection state.

This implementation was tested with an iPhone running nRF Connect for Mobile as the simulated peripheral and Chrome on Windows as the BLE central.

## Demo Video

[Watch the demo video](https://drive.google.com/file/d/13yEC-zHey0L4uiEk2FP1s-eFP5N3ocvn/view?usp=drive_link)

## BLE Profile

| Item | UUID | Properties |
| --- | --- | --- |
| Service | `0000FF00-0000-1000-8000-00805F9B34FB` | Primary service |
| Status characteristic | `0000FF01-0000-1000-8000-00805F9B34FB` | Read, Notify |
| Control characteristic | `0000FF02-0000-1000-8000-00805F9B34FB` | Write |

The status characteristic is interpreted as the first byte of the value, expected to be `0-100`. The control characteristic writes one byte from `0-255`.

## Requirements

- Windows laptop with Bluetooth enabled
- Chrome or Edge with Web Bluetooth support
- iPhone running nRF Connect for Mobile
- The app must be served from `localhost` or HTTPS because Web Bluetooth requires a secure context

## Running Locally

From this folder, start a static server:

```powershell
python -m http.server 5173
```

Then open Chrome or Edge at:

```txt
http://127.0.0.1:5173
```

If Python is not available, any static server is fine as long as the page is served from `localhost` or HTTPS.

## nRF Connect Setup

On the iPhone, use the Peripheral tab.

1. Add a server named `FlyTech BLE`.
2. Add primary service `0000FF00-0000-1000-8000-00805F9B34FB`.
3. Add status characteristic `0000FF01-0000-1000-8000-00805F9B34FB`.
4. Set status properties to `Read` and `Notify`.
5. Set status permissions to `Readable`.
6. Set the initial status value to `32` as a byte array. nRF shows this as hex, so the app displays it as decimal `50`.
7. Add control characteristic `0000FF02-0000-1000-8000-00805F9B34FB`.
8. Set control properties to `Write`.
9. Set control permissions to `Writable`.
10. Add an advertiser named `FlyTech BLE`.
11. Include advertised service `0000FF00-0000-1000-8000-00805F9B34FB`.
12. Start the server first, then start the advertiser.
13. Keep nRF Connect open while testing.

## Tested Behavior

- Scans for the peripheral by service UUID `FF00`
- Connects to the selected GATT server
- Reads `FF01` and displays the status value
- Starts notifications on `FF01`
- Updates the status UI when notifications are received
- Polls `FF01` every 2 seconds as an iPhone nRF Connect fallback
- Writes one byte to `FF02` from the slider or quick action buttons
- Detects disconnects and stale GATT sessions
- Remembers the selected device during the current browser session and supports quick reconnect

Verified values:

| Browser action | nRF value | Meaning |
| --- | --- | --- |
| Status `32` | `32` hex | App displays `50` decimal |
| Status `40` | `40` hex | App displays `64` decimal |
| Control `128` | `80` hex | One-byte write succeeded |
| Control `255` | `FF` hex | One-byte write succeeded |
| Control `0` | `00` hex | One-byte write succeeded |

## Simulator Notes

Chrome on Windows and nRF Connect on iOS worked well for scan, connect, read, notify subscription, status updates, and single-byte writes. One simulator-specific issue showed up during testing: repeated writes to the iPhone nRF peripheral in the same GATT session failed after the first successful write with a generic Chrome GATT error.

To keep the demo reliable, the app closes the GATT session after each successful control write and shows `Needs Reconnect`. Pressing `Reconnect` reuses the last selected Web Bluetooth device, rediscovers the service/characteristics, and prepares the app for the next write. With this flow, writes to `128`, `255`, and `0` were all verified in nRF Connect.

The app also subscribes to `FF01` notifications. nRF Connect iOS can be inconsistent about manually emitting notifications from its UI, so the app keeps a 2-second status polling fallback active while connected. On a real peripheral that emits notifications normally, the `characteristicvaluechanged` handler updates the UI immediately.

## Production Hardening

For production, I would move BLE operations into an explicit state machine covering scan, connect, service discovery, subscription, ready, reconnecting, and failed states. That would keep the UI, retries, and command availability predictable.

I would add bounded automatic reconnect with backoff, service rediscovery, notification resubscription, and a clear distinction between intentional disconnects and unexpected drops.

I would also serialize writes through a command queue with timeouts and optional device acknowledgements, then add structured logs for GATT errors, device identity, app version, and operation timing.

## With More Time

- Improve scan timeout, Bluetooth-off, and device-not-found messaging
- Persist remembered devices where browser support allows it
- Add automated tests around byte parsing and BLE state transitions
