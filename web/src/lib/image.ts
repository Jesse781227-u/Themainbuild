export async function imageDataUrl(file:File,maxBytes=180_000):Promise<string>{
  if(file.type==='image/svg+xml'){
    if(file.size>maxBytes)throw new Error(`SVG images must be ${Math.floor(maxBytes/1000)} KB or smaller. Choose a smaller SVG or export it as PNG or WebP.`);
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file)});
  }
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

// Resizes to at most 1200px and re-encodes as WebP, lowering quality until it fits maxBytes.
export async function compressImage(file:File,maxBytes=250_000):Promise<Blob>{
  if(file.type==='image/svg+xml'||file.type==='image/gif'){if(file.size>maxBytes)throw new Error(`${file.name} must be ${Math.floor(maxBytes/1000)} KB or smaller.`);return file}
  const source=await createImageBitmap(file);
  const scale=Math.min(1,1200/source.width,1200/source.height);
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(source.width*scale));canvas.height=Math.max(1,Math.round(source.height*scale));
  const context=canvas.getContext('2d');if(!context)throw new Error('Could not prepare image.');context.drawImage(source,0,0,canvas.width,canvas.height);source.close();
  const encode=(quality:number)=>new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Could not prepare image.')),'image/webp',quality));
  let quality=.8;let result=await encode(quality);
  while(result.size>maxBytes&&quality>.35){quality-=.08;result=await encode(quality)}
  return result;
}
