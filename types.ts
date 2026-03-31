
export enum ObjectType {
  STAR = 'star',
  GALAXY = 'galaxy',
  NEBULA = 'nebula',
  ASTEROID = 'asteroid',
  COMET = 'comet',
  METEOR = 'meteor',
  SATELLITE = 'satellite',
  SATELLITE_TRAIL = 'satellite_trail',
  SPACE_DEBRIS = 'space_debris',
  STREAK = 'streak',
  UNKNOWN = 'unknown'
}

export interface Identification {
  object_type: ObjectType;
  primary_name: string | null;
  best_catalog: string | null;
  catalog_id: string | null;
  ra: string;
  dec: string;
  separation_arcsec: number;
  confidence: number; // 0.0 - 1.0
  evidence: string[];
  recommended_followup: string;
  pixel_coords?: { x: number; y: number };
  reference_image_url?: string;
  verification_status?: 'wcs_confirmed' | 'ephemeris_only' | 'vision_only' | 'candidate';
  resolution_audit?: {
    databases_checked: string[];
    resolved: boolean;
    original_type?: string;
  };
  // Streak/debris characterization
  streak_info?: {
    length_pixels?: number;      // Streak length in pixels
    position_angle_deg?: number; // Angle of streak on image
    snr_estimate?: string;       // Estimated signal-to-noise ratio
    angular_velocity?: string;   // Estimated angular velocity
    orbit_regime?: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'unknown'; // Estimated orbit
    brightness_variation?: string; // Tumbling/rotation signature
    catalog_match?: string;      // Matched TLE/catalog object if any
  };
}

export interface AstrometryAnnotation {
  pixelx: number;
  pixely: number;
  radius: number;
  names: string[];
  type: string;
}

export interface PlateSolveMetadata {
  job_id?: number;
  annotated_image_url?: string;
  center_ra: string;
  center_dec: string;
  plate_scale: string;
  wcs_quality: number;
  field_of_view: string;
  constellation?: string;
  orientation?: number;
  pixscale?: number;
  annotations?: AstrometryAnnotation[];
  image_width?: number; // Width of the solved image (for normalization)
  image_height?: number; // Height of the solved image
}

export interface GroundingSource {
  title: string;
  uri: string;
  snippet?: string;
  image_url?: string;
}

export interface NeoObject {
  des: string;        // Designation (e.g., "433")
  fullname: string;   // Full name (e.g., "433 Eros (1898 DQ)")
  cd: string;         // Calendar Date of approach
  dist: string;       // Distance in AU
  dist_min: string;   // Min distance
  v_rel: string;      // Relative velocity (km/s)
  h: string;          // Absolute magnitude
  body?: string;      // Close approach body (usually Earth)
  ra?: string;        // RA in degrees (from Horizons ephemeris)
  dec?: string;       // Dec in degrees (from Horizons ephemeris)
  magnitude_v?: string; // Visual magnitude at observation time
  in_field?: boolean; // Whether this NEO falls within the user's plate-solved FOV
  pixel_x?: number;   // Pixel X position in user image (if in_field)
  pixel_y?: number;   // Pixel Y position in user image (if in_field)
}

export interface CometObservation {
  obs_date: string;
  magnitude: string;
  coma_diameter: string | null;
  tail_length: string | null;
  observer: string;
  method: string;
  conditions?: string;
}

export interface CometData {
  object: {
    name: string;
    fullname: string;
    type: string;
  };
  orbit: {
    e: number; // eccentricity
    q: number; // perihelion dist
    i: number; // inclination
    tp_cd: string; // time of perihelion
    per: number; // period
    epoch: string;
  };
  phys_par?: {
    H0: number; // Absolute mag
    n: number; // slope
  };
  recent_observations?: CometObservation[];
  signature?: {
    source: string;
    version: string;
  };
}

export interface HorizonsData {
  id: string;
  timestamp: string;
  ra: string;
  dec: string;
  magnitude?: string;
  distance_au?: string;
  velocity_kms?: string;
  constellation?: string;
}

export interface SatelliteMatch {
  name: string;
  noradId: string;
  intlDesignator: string;
  ra: number;
  dec: number;
  altitude: number;
  velocity: number;
  angularSep: number;
  magnitude?: string;
  pixelX?: number;
  pixelY?: number;
}

export interface IdentificationResult {
  identifications: Identification[];
  summary: string;
  plate_solve: PlateSolveMetadata;
  sources?: GroundingSource[];
  neos?: NeoObject[];
  comet?: CometData | null;
  horizons?: HorizonsData | null;
  satellites?: SatelliteMatch[];
  exif?: any;
  generated_annotation_image?: string;
}

export interface ImageExposureInfo {
  isStacked: boolean;
  subExposureSec: number;    // Single frame: 30 for "300x30s", 120 for "120s"
  totalExposureSec: number;  // Full integration: 9000 for "300x30s", 120 for "120s"
  frameCount: number;        // 300 for "300x30s", 1 for "120s"
  rawString: string;
}

export interface FactSheet {
  target_name: string | null;
  target_type: string | null;
  target_was_intentional: boolean;
  distance_au: string | null;
  magnitude: string | null;
  magnitude_source: 'COBS observed' | 'JPL predicted' | null;
  ra: string | null;
  dec: string | null;
  constellation: string | null;
  fov_degrees: string | null;
  exposure_info: string | null;
  image_type: 'stacked' | 'single' | 'unknown';
  observation_date: string | null;
  visible_streak_count: number;
  satellite_count_overhead: number;
  neo_count_in_field: number;
  identified_objects: string[];
}

export interface ThoughtLog {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'critical';
}

export interface ProcessingState {
  step: 'idle' | 'ingesting' | 'analyzing' | 'synthesis' | 'completed' | 'error';
  message: string;
  progress: number;
  logs: ThoughtLog[];
}
