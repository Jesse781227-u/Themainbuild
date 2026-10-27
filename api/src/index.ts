import {app} from './app';import {config} from './config';
app.listen(config.PORT,()=>console.log(`Relay API listening on :${config.PORT}`));
