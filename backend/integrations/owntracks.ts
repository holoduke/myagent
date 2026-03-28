import { IncomingMessage, ServerResponse } from "http";
import { FileStore } from "../utils/file-store.js";
import { recordObservation } from "../observer.js";
import { createLogger } from "../logger.js";

const log = createLogger("owntracks");

const OT_DIR = "/data/owntracks";
const STATE_FILE = `${OT_DIR}/state.json`;
const OWNTRACKS_USER = process.env.OWNTRACKS_USER || "";
const OWNTRACKS_DEVICE = process.env.OWNTRACKS_DEVICE || "";
const MIN_DISTANCE_METERS = 500;

interface OwnTracksLocation {
  lat: number;
  lon: number;
  acc: number;
  batt?: number;
  vel?: number;
  tst: number;
}

interface OTState {
  lastLocation: OwnTracksLocation | null;
}

const stateStore = new FileStore<OTState>({ filePath: STATE_FILE, defaultValue: { lastLocation: null } });

function loadState(): OTState {
  return stateStore.load();
}

function saveState(state: OTState): void {
  stateStore.save(state);
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function handleOwnTracksWebhook(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(body);

      // Only process location messages
      if (payload._type !== "location") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
        return;
      }

      // Validate lat/lon are finite numbers to prevent NaN propagation
      if (typeof payload.lat !== "number" || typeof payload.lon !== "number" ||
          !isFinite(payload.lat) || !isFinite(payload.lon)) {
        log(`Invalid lat/lon: lat=${payload.lat}, lon=${payload.lon}`);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid or missing lat/lon" }));
        return;
      }

      const location: OwnTracksLocation = {
        lat: payload.lat,
        lon: payload.lon,
        acc: payload.acc || 0,
        batt: payload.batt,
        vel: payload.vel,
        tst: payload.tst || Math.floor(Date.now() / 1000),
      };

      const state = loadState();

      // Check if location changed significantly
      let significant = true;
      if (state.lastLocation) {
        const dist = haversineDistance(
          state.lastLocation.lat,
          state.lastLocation.lon,
          location.lat,
          location.lon,
        );
        significant = dist >= MIN_DISTANCE_METERS;
      }

      if (significant) {
        recordObservation({
          timestamp: location.tst * 1000,
          sender: "OwnTracks",
          senderJid: `owntracks:${OWNTRACKS_USER}/${OWNTRACKS_DEVICE}`,
          isGroup: false,
          isFromMe: false,
          text: `[LOCATION] Moved to ${location.lat.toFixed(5)},${location.lon.toFixed(5)} (acc: ${location.acc}m)`,
          source: "owntracks",
          locationMeta: {
            lat: location.lat,
            lon: location.lon,
            accuracy: location.acc,
            battery: location.batt,
            velocity: location.vel,
          },
        });

        log(`Significant location change: ${location.lat.toFixed(5)},${location.lon.toFixed(5)}`);
      }

      // Always update last location
      state.lastLocation = location;
      saveState(state);

      // OwnTracks expects an empty array response
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
    } catch (err) {
      log(`OwnTracks webhook error: ${err}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid payload" }));
    }
  });
}

export function getOwnTracksStatus(): { enabled: boolean; lastLocation: { lat: number; lon: number; timestamp: number; battery?: number } | null } {
  const enabled = !!(OWNTRACKS_USER && OWNTRACKS_DEVICE);
  const state = loadState();

  return {
    enabled,
    lastLocation: state.lastLocation
      ? {
          lat: state.lastLocation.lat,
          lon: state.lastLocation.lon,
          timestamp: state.lastLocation.tst * 1000,
          battery: state.lastLocation.batt,
        }
      : null,
  };
}
