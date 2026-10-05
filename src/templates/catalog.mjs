import defaults from './classic/defaults.json' with {type:'json'};
const freeze = (value) => {
  for (const item of Object.values(value)) if (item && typeof item==='object') freeze(item);
  return Object.freeze(value);
};
export const classicDefaults=freeze(defaults);
const catalog=freeze([{id:'classic',version:'1',label:'Classic',defaultVariationId:'default',variations:[{
  id:'default',label:'Default',treatment:{id:'audiogram-basic',version:'1'},compositionId:'AudiogramBasic'
}]}]);
export const listTemplates=()=>catalog;
export const resolveTemplateSelection=(input={})=>{
  const invalid=()=>Object.assign(new Error('Unknown template selection. Available: classic / 1 / default.'),{code:'INVALID_TEMPLATE_SELECTION'});
  if(!input || typeof input!=='object'||Array.isArray(input))throw invalid();
  const allowed=['templateId','templateVersion','variationId'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw invalid();
  const selection={templateId:'classic',templateVersion:'1',variationId:'default',...input};
  if(allowed.some(key=>typeof selection[key]!=='string'||!selection[key]))throw invalid();
  const template=catalog.find(t=>t.id===selection.templateId&&t.version===selection.templateVersion);
  const variation=template?.variations.find(v=>v.id===selection.variationId);
  if(!variation)throw invalid();
  return {selection,treatment:{...variation.treatment},compositionId:variation.compositionId,renderKey:`${variation.treatment.id}@${variation.treatment.version}`};
};
