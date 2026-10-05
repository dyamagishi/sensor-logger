import { slideDirection } from './ambient';

export class AmbientSlider {
  private page=0;
  private animations:Animation[]=[];
  private leaving:HTMLElement|undefined;

  constructor(private pages:HTMLElement[]) {
    this.pages.forEach((el,index)=>{
      el.classList.toggle('is-current',index===0);
      el.inert=index!==0;
      el.setAttribute('aria-hidden',String(index!==0));
    });
  }

  select(page:number,direction=slideDirection(this.page,page,this.pages.length)) {
    if(page===this.page)return;
    // A second gesture can interrupt a slide without retaining an old leaving panel.
    this.animations.forEach(animation=>animation.cancel());
    this.animations=[];
    this.leaving?.classList.remove('is-leaving');
    const outgoing=this.pages[this.page],incoming=this.pages[page];
    this.page=page;
    this.pages.forEach((el,index)=>{
      el.classList.toggle('is-current',index===page);
      el.inert=index!==page;
      el.setAttribute('aria-hidden',String(index!==page));
    });
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    outgoing.classList.add('is-leaving');
    this.leaving=outgoing;
    const options={duration:400,easing:'cubic-bezier(.25,.8,.25,1)'};
    const exit=outgoing.animate([{transform:'translateX(0)'},{transform:`translateX(${-direction*100}%)`}],options);
    const enter=incoming.animate([{transform:`translateX(${direction*100}%)`},{transform:'translateX(0)'}],options);
    this.animations=[exit,enter];
    exit.onfinish=()=>{outgoing.classList.remove('is-leaving');if(this.leaving===outgoing)this.leaving=undefined;};
  }
}
