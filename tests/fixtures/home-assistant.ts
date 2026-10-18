import type { HaEntityEntry, HaNames, HaState } from "@/infrastructure/home/home-assistant";

/** A small home as Home Assistant reports it (documented shapes, made-up ids). */
export const HA_STATES: HaState[] = [
  {
    entity_id: "light.escritorio",
    state: "on",
    attributes: {
      friendly_name: "Escritorio Lamp",
      brightness: 128,
      rgb_color: [0, 255, 0],
      supported_color_modes: ["rgb", "color_temp"],
      min_color_temp_kelvin: 2200,
      max_color_temp_kelvin: 6500,
      color_temp_kelvin: 4000,
    },
    last_updated: "2026-10-18T20:00:00Z",
  },
  // Diagnostics of the same lamp: never ELISE devices.
  {
    entity_id: "sensor.escritorio_rssi",
    state: "-60",
    attributes: { device_class: "signal_strength" },
  },
  { entity_id: "update.escritorio_firmware", state: "off", attributes: {} },
  { entity_id: "light.living", state: "off", attributes: { supported_color_modes: ["onoff"] } },
  {
    entity_id: "climate.aire_living",
    state: "cool",
    attributes: {
      current_temperature: 26,
      temperature: 24,
      min_temp: 16,
      max_temp: 30,
      target_temp_step: 1,
      hvac_modes: ["off", "cool", "heat", "auto"],
      fan_modes: ["low", "high"],
      fan_mode: "low",
    },
  },
  { entity_id: "switch.humidificador", state: "off", attributes: {} },
  {
    entity_id: "fan.ventilador",
    state: "on",
    attributes: { percentage: 40, supported_features: 1 },
  },
  {
    entity_id: "humidifier.dormitorio",
    state: "on",
    attributes: { humidity: 50, current_humidity: 41, min_humidity: 30, max_humidity: 80 },
  },
  {
    entity_id: "media_player.tv",
    state: "paused",
    attributes: {
      volume_level: 0.2,
      supported_features: 4 | 1 | 16384 | 128 | 256 | 2048,
      source_list: ["HDMI 1", "Netflix"],
      source: "Netflix",
    },
  },
  {
    entity_id: "sensor.living_temp",
    state: "23.5",
    attributes: { device_class: "temperature", unit_of_measurement: "°C" },
  },
  {
    entity_id: "sensor.living_hum",
    state: "48",
    attributes: { device_class: "humidity", unit_of_measurement: "%" },
  },
  {
    entity_id: "light.patio",
    state: "unavailable",
    attributes: { supported_color_modes: ["brightness"] },
  },
  { entity_id: "automation.wake", state: "on", attributes: {} },
];

export const HA_ENTRIES: HaEntityEntry[] = [
  { entity_id: "light.escritorio", device_id: "dev_lamp", area_id: null },
  { entity_id: "sensor.escritorio_rssi", device_id: "dev_lamp", entity_category: "diagnostic" },
  { entity_id: "update.escritorio_firmware", device_id: "dev_lamp", entity_category: "config" },
  { entity_id: "light.living", device_id: "dev_living", area_id: null },
  { entity_id: "climate.aire_living", device_id: "dev_ac", area_id: null },
  { entity_id: "switch.humidificador", device_id: null, area_id: "dormitorio" },
  { entity_id: "fan.ventilador", device_id: "dev_fan" },
  { entity_id: "humidifier.dormitorio", device_id: "dev_hum" },
  { entity_id: "media_player.tv", device_id: "dev_tv" },
  { entity_id: "sensor.living_temp", device_id: "dev_sensor" },
  { entity_id: "sensor.living_hum", device_id: "dev_sensor" },
  { entity_id: "light.patio", device_id: "dev_patio" },
];

export const HA_NAMES: HaNames = {
  devices: [
    { id: "dev_lamp", name: "Luz escritorio", area: "escritorio" },
    { id: "dev_living", name: "Luz principal", area: "living" },
    { id: "dev_ac", name: "Aire", area: "living" },
    { id: "dev_fan", name: "Ventilador", area: "dormitorio" },
    { id: "dev_hum", name: "Humidificador", area: "dormitorio" },
    { id: "dev_tv", name: "TV", area: "living" },
    { id: "dev_sensor", name: "Sensor living", area: "living" },
    { id: "dev_patio", name: "Luz patio", area: null },
  ],
  areas: [
    { id: "living", name: "Living" },
    { id: "escritorio", name: "Escritorio" },
    { id: "dormitorio", name: "Dormitorio" },
    { id: "garage", name: "Garage" },
  ],
};
