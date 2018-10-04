extern crate wasm_bindgen;
extern crate js_sys;
extern crate pixi_js;

use pixi_js::*;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn start_pixi() {
	let options = pixi::ApplicationOptions::new();
	options.set_width(Some(800.));
	options.set_height(Some(600.));
	options.set_background_color(Some(0x1099bb as f64));
	let app = pixi::Application::new(Some(&options));

	let body = web_sys::window().unwrap().document().unwrap().body().unwrap();
	let body_node : &web_sys::Node = body.as_ref();
	body_node.append_child(&app.view().into()).unwrap();

	// create a new Sprite from an image path
	let bunny = pixi::Sprite::from_image(&"bunny.png".into(), None, None);

	// center the sprite's anchor point
	bunny.anchor().set(Some(0.5), Some(0.5));

	// move the sprite to the center of the screen
	bunny.set_x(app.screen().width() / 2.);
	bunny.set_y(app.screen().height() / 2.);

	app.stage().add_child(&bunny);

	/*let update = move |delta: f64| {
		bunny.set_rotation(bunny.get_rotation() + 0.01 * delta);
	};

	let updateHandle = FnHandle::from_fn(update);

	app.get_ticker().add(updateHandle, ::stdweb::Undefined, None);
	//app.get_ticker().add(js!(return @{update};).as_any(), ::stdweb::Undefined, None);
	//app.get_ticker().add(AsAny::as_any(update), ::stdweb::Undefined, None);

	/*app.get_ticker().add(js!(return function(delta) {
		// just for fun, let's rotate mr rabbit a little
		// delta is 1 if running at 100% performance
		// creates frame-independent transformation
		@{bunny}.rotation += 0.1 * delta;
	};).as_any(), ::stdweb::Undefined, None);*/*/
}
