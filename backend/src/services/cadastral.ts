/**
 * Cadastral enrichment from Ramallah Municipality GIS (ArcGIS REST).
 *
 * After resolving an address to GPS coordinates, this service queries
 * the municipality's public ArcGIS layers to attach official cadastral
 * data: neighborhood (حي), block (حوض), parcel (قطعة), street address,
 * and postcode. This bridges colloquial addresses to the formal system.
 *
 * Layers:
 *   - Parcels: block name, quarter name, parcel number, city
 *   - Buildings: neighborhood, street address, postcode, road name
 *
 * The GIS uses EPSG:28191 (Palestine 1923 Grid), so we project via
 * ArcGIS Geometry Service before querying.
 */

const GEOMETRY_SERVER = 'https://utility.arcgisonline.com/arcgis/rest/services/Geometry/GeometryServer/project';
const PARCELS_URL = 'https://utility.arcgis.com/usrsvcs/servers/271016d99c314631a1c3a0b94a4d923c/rest/services/Basemap_emp/Parcels_Ramallah_AlBeirh/MapServer/1/query';
const BUILDINGS_URL = 'https://utility.arcgis.com/usrsvcs/servers/e38bbc917fda450dbfa3f1cdda2bda44/rest/services/Basemap_emp/RamallahBuildingsOpen/MapServer/0/query';

const TIMEOUT = 5000;

export interface CadastralInfo {
  neighborhood: string | null;   // حي — e.g. "حي قدورة"
  block: string | null;          // حوض — e.g. "19-المدينة"
  quarter: string | null;        // quarter name — e.g. "غسان"
  parcel: string | null;         // parcel number
  street_address: string | null; // formal address — e.g. "17 شارع خليل صلاح"
  postcode: string | null;
  city: string | null;
}

/** Project WGS84 lat/lng to Palestine Grid (EPSG:28191) via ArcGIS Geometry Service */
async function toLocalGrid(lat: number, lng: number): Promise<{ x: number; y: number } | null> {
  try {
    const geom = encodeURIComponent(JSON.stringify({
      geometryType: 'esriGeometryPoint',
      geometries: [{ x: lng, y: lat }],
    }));
    const url = `${GEOMETRY_SERVER}?inSR=4326&outSR=28191&geometries=${geom}&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json() as any;
    if (data.geometries?.[0]) {
      return { x: Math.round(data.geometries[0].x), y: Math.round(data.geometries[0].y) };
    }
  } catch { /* offline — no enrichment */ }
  return null;
}

/** Query an ArcGIS layer by point (in native EPSG:28191 coordinates) */
async function queryLayer(baseUrl: string, x: number, y: number, outFields: string): Promise<any | null> {
  try {
    // Use a small envelope (±50m) for reliable intersection
    const env = `${x - 50},${y - 50},${x + 50},${y + 50}`;
    const url = `${baseUrl}?geometry=${env}&geometryType=esriGeometryEnvelope&spatialRel=esriSpatialRelIntersects&outFields=${outFields}&f=json&resultRecordCount=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
    const data = await res.json() as any;
    if (data.features?.length > 0) {
      return data.features[0].attributes;
    }
  } catch { /* offline */ }
  return null;
}

/**
 * Enrich a resolved GPS coordinate with official cadastral data from
 * the Ramallah Municipality GIS.
 *
 * Returns null if:
 *   - coordinates are outside Ramallah municipality coverage
 *   - the GIS service is unreachable (offline demo)
 *   - projection fails
 */
export async function enrichCadastral(lat: number, lng: number): Promise<CadastralInfo | null> {
  // Quick bounds check — Ramallah municipality is roughly 31.87–31.93 N, 35.17–35.23 E
  if (lat < 31.85 || lat > 31.95 || lng < 35.15 || lng > 35.25) {
    return null; // outside Ramallah — no cadastral data
  }

  const grid = await toLocalGrid(lat, lng);
  if (!grid) return null;

  // Query both layers in parallel
  const [parcel, building] = await Promise.all([
    queryLayer(PARCELS_URL, grid.x, grid.y,
      'BLOCKNONAME,QUARTERNONAME,PARCEL_NO,CITY,BLOCK_NO_STRING,QUARTER_NO_STRING'),
    queryLayer(BUILDINGS_URL, grid.x, grid.y,
      'NEIGHBORHOOD,ADDRESS,ADDRESS_ENGLISH,POSTCODE,ROAD_NAME_ARABIC,BLOCK_NA,QUARTER_NA,PARCEL_NO'),
  ]);

  if (!parcel && !building) return null;

  return {
    neighborhood: building?.NEIGHBORHOOD ?? null,
    block: parcel?.BLOCKNONAME ?? building?.BLOCK_NA ?? null,
    quarter: parcel?.QUARTERNONAME ?? building?.QUARTER_NA ?? null,
    parcel: String(parcel?.PARCEL_NO ?? building?.PARCEL_NO ?? ''),
    street_address: building?.ADDRESS ?? null,
    postcode: building?.POSTCODE ? String(building.POSTCODE) : null,
    city: parcel?.CITY ?? 'رام الله',
  };
}
