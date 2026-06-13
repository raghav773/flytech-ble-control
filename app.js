const SERVICE_UUID = "0000ff00-0000-1000-8000-00805f9b34fb";
const STATUS_CHARACTERISTIC_UUID = "0000ff01-0000-1000-8000-00805f9b34fb";
const CONTROL_CHARACTERISTIC_UUID = "0000ff02-0000-1000-8000-00805f9b34fb";
const STATUS_POLL_INTERVAL_MS = 2000;

const connectionStateEl = document.querySelector("#connectionState");
const connectionDetailEl = document.querySelector("#connectionDetail");
const supportMessageEl = document.querySelector("#supportMessage");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const reconnectButton = document.querySelector("#reconnectButton");
const statusValueEl = document.querySelector("#statusValue");
const controlValueEl = document.querySelector("#controlValue");
const controlSlider = document.querySelector("#controlSlider");
const quickActionButtons = document.querySelectorAll("[data-control-value]");
const eventLog = document.querySelector("#eventLog");
const clearLogButton = document.querySelector("#clearLogButton");

let device = null;
let server = null;
let statusCharacteristic = null;
let controlCharacteristic = null;
let writeInFlight = false;
let pendingControlValue = null;
let isDisconnectingAfterWrite = false;
let statusPollId = null;
let lastStatusValue = null;

function setConnectionState(state, detail = "") {
  connectionStateEl.textContent = state;
  connectionDetailEl.textContent = detail || getDefaultStateDetail(state);
  connectionStateEl.className = "connection-pill";

  if (state === "Connected") {
    connectionStateEl.classList.add("connected");
  } else if (
    state === "Scanning" ||
    state === "Connecting" ||
    state === "Reconnecting" ||
    state === "Needs Reconnect"
  ) {
    connectionStateEl.classList.add("busy");
  } else if (state === "Error") {
    connectionStateEl.classList.add("error");
  }

  if (detail) {
    logEvent(`${state}: ${detail}`);
  } else {
    logEvent(state);
  }
}

function getDefaultStateDetail(state) {
  switch (state) {
    case "Connected":
      return "Connected to the BLE peripheral. Status notifications and simulator polling are active.";
    case "Scanning":
      return "Choose the FlyTech BLE peripheral from the browser Bluetooth prompt.";
    case "Connecting":
      return "Opening a GATT connection and discovering service FF00.";
    case "Reconnecting":
      return "Reusing the last selected device and rediscovering characteristics.";
    case "Needs Reconnect":
      return "The last control write completed. Reconnect before sending another control value.";
    case "Error":
      return "A BLE operation failed. Check Bluetooth, browser permissions, and the iPhone simulator.";
    case "Disconnected":
    default:
      return "Disconnected. Start the iPhone server and advertiser, then connect.";
  }
}

function setConnectedControls(isConnected) {
  connectButton.disabled = isConnected;
  disconnectButton.disabled = !isConnected;
  controlSlider.disabled = !isConnected;
  quickActionButtons.forEach((button) => {
    button.disabled = !isConnected;
  });
  reconnectButton.disabled = !device || isConnected;
}

function setWriteControlsEnabled(isEnabled) {
  controlSlider.disabled = !isEnabled;
  quickActionButtons.forEach((button) => {
    button.disabled = !isEnabled;
  });
}

function stopStatusPolling() {
  if (statusPollId !== null) {
    window.clearInterval(statusPollId);
    statusPollId = null;
    logEvent("Status polling stopped.");
  }
}

function showSupportMessage(message) {
  supportMessageEl.textContent = message;
  supportMessageEl.hidden = false;
}

function logEvent(message) {
  const item = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, ` ${message}`);
  eventLog.prepend(item);

  while (eventLog.children.length > 60) {
    eventLog.lastElementChild.remove();
  }
}

function parseSingleByteValue(dataView) {
  if (!dataView || dataView.byteLength < 1) {
    throw new Error("Characteristic value was empty.");
  }

  return dataView.getUint8(0);
}

function updateStatusValue(dataView, source = "updated") {
  const value = parseSingleByteValue(dataView);
  const didChange = value !== lastStatusValue;
  lastStatusValue = value;
  statusValueEl.textContent = value.toString();

  if (didChange) {
    logEvent(`Status ${source} to ${value}`);
  }
}

function handleStatusNotification(event) {
  updateStatusValue(event.target.value, "notification changed");
}

function handleDisconnected() {
  stopStatusPolling();
  server = null;
  statusCharacteristic = null;
  controlCharacteristic = null;

  if (isDisconnectingAfterWrite) {
    isDisconnectingAfterWrite = false;
    setConnectedControls(false);
    setConnectionState("Needs Reconnect", "Write complete. Reconnect before the next control write.");
    return;
  }

  setConnectedControls(false);
  setConnectionState("Disconnected", "Peripheral disconnected.");
}

function describeControlProperties(characteristic) {
  return describeCharacteristicProperties(characteristic);
}

function describeCharacteristicProperties(characteristic) {
  const properties = characteristic.properties;
  const supported = [];

  if (properties.write) {
    supported.push("write");
  }

  if (properties.writeWithoutResponse) {
    supported.push("writeWithoutResponse");
  }

  if (properties.read) {
    supported.push("read");
  }

  if (properties.notify) {
    supported.push("notify");
  }

  return supported.length ? supported.join(", ") : "none reported";
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function writeControlPayload(payload) {
  if (!server?.connected) {
    throw new Error("GATT server is not connected.");
  }

  const service = await server.getPrimaryService(SERVICE_UUID);
  controlCharacteristic = await service.getCharacteristic(CONTROL_CHARACTERISTIC_UUID);
  const properties = controlCharacteristic.properties;

  if (properties.write && "writeValueWithResponse" in controlCharacteristic) {
    await controlCharacteristic.writeValueWithResponse(payload);
    return "with response";
  }

  if (properties.writeWithoutResponse && "writeValueWithoutResponse" in controlCharacteristic) {
    await controlCharacteristic.writeValueWithoutResponse(payload);
    return "without response";
  }

  await controlCharacteristic.writeValue(payload);
  return "default";
}

function markGattSessionStale(error) {
  stopStatusPolling();
  controlCharacteristic = null;
  setWriteControlsEnabled(false);
  setConnectionState(
    "Error",
    `Control write failed: ${error.message}. Disconnect and reconnect to rediscover services.`,
  );
}

function markWriteCompleteNeedsReconnect() {
  stopStatusPolling();
  server = null;
  statusCharacteristic = null;
  controlCharacteristic = null;
  setConnectedControls(false);
  setConnectionState("Needs Reconnect", "Write complete. Reconnect before the next control write.");
}

async function pollStatusValue() {
  if (!server?.connected || !statusCharacteristic) {
    stopStatusPolling();
    return;
  }

  try {
    const statusValue = await statusCharacteristic.readValue();
    const value = parseSingleByteValue(statusValue);

    if (value !== lastStatusValue) {
      lastStatusValue = value;
      statusValueEl.textContent = value.toString();
      logEvent(`Status poll changed to ${value}`);
    }
  } catch (error) {
    stopStatusPolling();
    controlCharacteristic = null;
    setConnectedControls(false);
    setConnectionState("Disconnected", `Status poll lost the peripheral: ${error.message}`);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusPollId = window.setInterval(pollStatusValue, STATUS_POLL_INTERVAL_MS);
  logEvent(`Status polling started (${STATUS_POLL_INTERVAL_MS}ms fallback).`);
}

async function discoverCharacteristics() {
  if (!server?.connected) {
    throw new Error("GATT server is disconnected.");
  }

  const service = await server.getPrimaryService(SERVICE_UUID);
  statusCharacteristic = await service.getCharacteristic(STATUS_CHARACTERISTIC_UUID);
  controlCharacteristic = await service.getCharacteristic(CONTROL_CHARACTERISTIC_UUID);
  logEvent(`Status properties: ${describeCharacteristicProperties(statusCharacteristic)}`);
  logEvent(`Control properties: ${describeControlProperties(controlCharacteristic)}`);

  const statusValue = await statusCharacteristic.readValue();
  updateStatusValue(statusValue);

  logEvent("Starting status notifications.");
  await statusCharacteristic.startNotifications();
  logEvent("Status notifications started.");
  statusCharacteristic.removeEventListener("characteristicvaluechanged", handleStatusNotification);
  statusCharacteristic.addEventListener("characteristicvaluechanged", handleStatusNotification);
  startStatusPolling();
}

function disconnectAfterSuccessfulWrite() {
  setWriteControlsEnabled(false);
  logEvent("Write complete. Closing GATT session before the next write.");

  if (!device?.gatt?.connected) {
    markWriteCompleteNeedsReconnect();
    return;
  }

  isDisconnectingAfterWrite = true;
  device.gatt.disconnect();
}

async function connectToDevice(selectedDevice) {
  setConnectionState(device ? "Reconnecting" : "Connecting");
  setConnectedControls(false);

  device = selectedDevice;
  device.removeEventListener("gattserverdisconnected", handleDisconnected);
  device.addEventListener("gattserverdisconnected", handleDisconnected);

  server = await device.gatt.connect();
  await discoverCharacteristics();

  setConnectedControls(true);
  setConnectionState("Connected", device.name || "BLE peripheral");
}

async function requestAndConnect() {
  try {
    setConnectionState("Scanning");
    const selectedDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });

    await connectToDevice(selectedDevice);
  } catch (error) {
    setConnectedControls(false);

    if (error.name === "NotFoundError") {
      setConnectionState("Disconnected", "No device selected.");
      return;
    }

    setConnectionState("Error", error.message);
  }
}

async function reconnect() {
  if (!device) {
    logEvent("No previously selected device is available to reconnect.");
    return;
  }

  try {
    await connectToDevice(device);
  } catch (error) {
    setConnectedControls(false);
    setConnectionState("Error", error.message);
  }
}

async function disconnect() {
  if (!device?.gatt?.connected) {
    handleDisconnected();
    return;
  }

  device.gatt.disconnect();
}

async function writeControlValue(value) {
  const normalizedValue = Math.max(0, Math.min(255, Number(value)));
  controlValueEl.textContent = normalizedValue.toString();
  controlSlider.value = normalizedValue.toString();

  if (!controlCharacteristic) {
    logEvent("Control write skipped because no device is connected.");
    return;
  }

  if (writeInFlight) {
    pendingControlValue = normalizedValue;
    return;
  }

  writeInFlight = true;

  try {
    const payload = new Uint8Array([normalizedValue]);
    const writeMode = await writeControlPayload(payload);
    logEvent(`Control wrote ${normalizedValue} (${writeMode})`);
    await wait(250);
    disconnectAfterSuccessfulWrite();
  } catch (error) {
    markGattSessionStale(error);
  } finally {
    writeInFlight = false;

    if (pendingControlValue !== null && pendingControlValue !== normalizedValue) {
      const nextValue = pendingControlValue;
      pendingControlValue = null;
      await writeControlValue(nextValue);
    } else {
      pendingControlValue = null;
    }
  }
}

function initialize() {
  setConnectedControls(false);

  if (!("bluetooth" in navigator)) {
    connectButton.disabled = true;
    reconnectButton.disabled = true;
    showSupportMessage(
      "Web Bluetooth is not available in this browser. Use Chrome or Edge on Windows with Bluetooth enabled.",
    );
    setConnectionState("Error", "Web Bluetooth unavailable.");
    return;
  }

  logEvent("Ready. Configure the iPhone peripheral, then choose Connect.");
}

connectButton.addEventListener("click", requestAndConnect);
disconnectButton.addEventListener("click", disconnect);
reconnectButton.addEventListener("click", reconnect);

controlSlider.addEventListener("input", (event) => {
  controlValueEl.textContent = event.target.value;
});

controlSlider.addEventListener("change", (event) => {
  writeControlValue(event.target.value);
});

quickActionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    writeControlValue(button.dataset.controlValue);
  });
});

clearLogButton.addEventListener("click", () => {
  eventLog.replaceChildren();
});

initialize();
