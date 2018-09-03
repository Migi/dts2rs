#[macro_use]
extern crate stdweb;

extern crate pixi_js;

use pixi_js::prelude::*;
use stdweb::web::*;

fn example_main() -> Result<(), &'static str> {
	let pixi = pixi_js::PIXI::__LazyNamespace_PIXI::__init_from_js_value(js!(return PIXI;))?;

	/*let app = pixi.Application()?.new1(Some(js!(return {
		width: 800,
		height: 600,
		backgroundColor : 0x1099bb
	};).to_any()));*/

	let options = pixi.ApplicationOptions().new();
	options
		.set_width(Some(800.))
		.set_height(Some(600.))
		.set_backgroundColor(Some(0x1099bb as f64));
	let app = pixi.Application()?.new1(Some(options));
	document().body().expect("No body found!").append_child(&app.get_view());

	// create a new Sprite from an image path
	let bunny = pixi.Sprite()?.fromImage("bunny.png", None, None);

	// center the sprite's anchor point
	bunny.get_anchor().set(Some(0.5), Some(0.5));

	// move the sprite to the center of the screen
	bunny.set_x(app.get_screen().get_width() / 2.);
	bunny.set_y(app.get_screen().get_height() / 2.);

	app.get_stage().addChild(&bunny);

	app.get_ticker().add(js!(return function(delta) {
		// just for fun, let's rotate mr rabbit a little
		// delta is 1 if running at 100% performance
		// creates frame-independent transformation
		@{bunny}.rotation += 0.1 * delta;
	};).as_any(), ::stdweb::Undefined, None);

	Ok(())
}

fn main() {
	let promise = pixi_js::__requireFromUrl__pixi_js("https://cdnjs.cloudflare.com/ajax/libs/pixi.js/4.8.1/pixi.min.js");

	let _done_handle = promise.done(|res: Result<stdweb::Value, stdweb::Value>| {
		if res.is_err() {
			console!(error, "Failed to load script");
			return;
		}

		example_main().unwrap();
	});

	_done_handle.leak();
}