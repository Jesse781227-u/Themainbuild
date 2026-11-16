export type BusinessCategory='food_beverage'|'fashion_retail'|'beauty_wellness'|'photography_events'|'general_services'|'other';
export interface Business{id:string;name:string;category:BusinessCategory;phone:string;timezone:string;currency:string;logoUrl:string|null;brandColor:string;status:'onboarding'|'active';createdAt:string;updatedAt:string}
