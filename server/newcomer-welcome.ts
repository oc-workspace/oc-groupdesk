/** Only this explicitly selected, published feature grants welcome admission.
 * Other Persona features remain expression-only. Timing is enforced by adapters.
 */
export const newcomerWelcomePolicy=Object.freeze({min_delay_seconds:15,max_delay_seconds:40,ttl_seconds:90,coalesce_seconds:120});
export function welcomeRuntime(features:{skill_name?:string}[]){
 return features.some(f=>f.skill_name==='newcomer-welcome')?{newcomer_welcome_contract_version:1 as const,newcomer_welcome:{...newcomerWelcomePolicy}}:{};
}
