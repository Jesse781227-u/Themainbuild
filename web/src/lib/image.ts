export async function imageDataUrl(file:File,maxBytes=180_000):Promise<string>{
  if(file.type==='image/svg+xml')return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file)});
  const source=await createImageBitmap(file);
  const scale=Math.min(1,1200/source.width,1200/source.height);
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(source.width*scale));canvas.height=Math.max(1,Math.round(source.height*scale));
  const context=canvas.getContext('2d');if(!context)throw new Error('Could not prepare image.');context.drawImage(source,0,0,canvas.width,canvas.height);source.close();
  let quality=.78;let result=canvas.toDataURL('image/webp',quality);
  while(result.length>maxBytes*1.37&&quality>.35){quality-=.08;result=canvas.toDataURL('image/webp',quality)}
  return result;
}

export async function optimizeImageDataUrl(value:string):Promise<string>{
  if(!value.startsWith('data:image/'))return value;
  const response=await fetch(value);const blob=await response.blob();return imageDataUrl(new File([blob],'upload-image',{type:blob.type}));
}
