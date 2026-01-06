
export enum ObjectType {
  STAR = 'star',
  GALAXY = 'galaxy',
  NEBULA = 'nebula',
  ASTEROID = 'asteroid',
  COMET = 'comet',
  METEOR = 'meteor',
  SATELLITE = 'satellite',
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
  reference_image_url?: string; // New field for web photos
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

export interface IdentificationResult {
  identifications: Identification[];
  summary: string;
  plate_solve: PlateSolveMetadata;
  sources?: GroundingSource[];
  neos?: NeoObject[];
  comet?: CometData | null;
  horizons?: HorizonsData | null;
  exif?: any;
  generated_annotation_image?: string; // New field for Nano Banana Pro output
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
