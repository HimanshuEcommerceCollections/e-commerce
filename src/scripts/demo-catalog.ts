/**
 * The design's sample catalog (designs/03-product-page.html, PRODUCTS), as
 * data for the demo seed (src/scripts/seed-demo.ts). Rows keep the design's
 * call shape so the two can be compared line by line; ratings and review
 * counts are kept for fidelity but not stored (reviews are P1).
 */

export interface DemoProduct {
  dept: string;
  /** Clothing: Men/Women; other departments: the section name. */
  g: string;
  brand: string;
  name: string;
  type: string;
  price: number;
  was: number | null;
  colors: string[];
  sizes: string[];
  /** Raw attribute values from the design (fit, material, conn, diet, skin, format, age, activity, occasion). */
  a: Record<string, string | string[]>;
  stock: number;
  pop: number;
  isNew: boolean;
  img?: string;
}

const ALPHA = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const WAIST = ['28', '30', '32', '34', '36', '38'];
const WNUM = ['0', '2', '4', '6', '8', '10', '12', '14', '16'];
const A = (...out: string[]) => ALPHA.filter((s) => !out.includes(s));
const W = (...out: string[]) => WAIST.filter((s) => !out.includes(s));
const N = (...out: string[]) => WNUM.filter((s) => !out.includes(s));

/** Clothing: p(gender, brand, name, type, price, was, colors, sizes, fit, material, stock, pop, isNew, rating, reviews, img, href) */
const p = (
  g: string, brand: string, name: string, type: string, price: number, was: number | null,
  colors: string[], sizes: string[], fit: string, material: string, stock: number, pop: number,
  isNew: number, _r: number, _rc: number, img?: string, _href?: string,
): DemoProduct => ({ dept: 'Clothing', g, brand, name, type, price, was, colors, sizes, a: { fit, material }, stock, pop, isNew: !!isNew, img });

/** Other departments: q(dept, section, brand, name, type, price, was, stock, pop, isNew, rating, reviews, attrs, colors, img) */
const q = (
  dept: string, g: string, brand: string, name: string, type: string, price: number, was: number | null,
  stock: number, pop: number, isNew: number, _r: number, _rc: number,
  a: Record<string, string | string[]> = {}, colors: string[] = [], img?: string,
): DemoProduct => ({ dept, g, brand, name, type, price, was, colors, sizes: [], a, stock, pop, isNew: !!isNew, img });

const E = 'Electronics', H = 'Home & Kitchen', GR = 'Grocery', B = 'Beauty & Personal Care', K = 'Books & Stationery',
  T = 'Toys & Kids', S_ = 'Sports & Fitness', L = 'Lifestyle';

// prettier-ignore
export const DEMO_PRODUCTS: DemoProduct[] = [
  p("Men","Basix","Classic Crew Tee","T-shirts & polos",14.99,null,["White","Black","Heather Gray","Navy"],A(),"Regular","Cotton",120,98,0,4.6,412),
  p("Men","Basix","Pocket Tee, 2-Pack","T-shirts & polos",24.99,29.99,["Black","White"],A("XS"),"Regular","Cotton",60,80,0,4.4,188),
  p("Men","Northfold","Piqué Polo Shirt","T-shirts & polos",29.99,null,["Navy","White","Olive"],A("XXL"),"Slim","Cotton",45,72,0,4.3,96),
  p("Men","FitCore","Performance Polo","T-shirts & polos",34.99,44.99,["Charcoal","Navy"],A(),"Slim","Polyester",30,61,0,4.5,74),
  p("Men","Northfold","Oxford Button-Down Shirt","Shirts",44.99,null,["White","Sky"],A("XS"),"Slim","Cotton",38,77,0,4.6,152),
  p("Men","Coastline","Linen-Blend Shirt","Shirts",39.99,null,["Cream","Sage"],A("XS","XXL"),"Relaxed","Linen",25,58,1,4.2,31),
  p("Men","Basix","Brushed Flannel Shirt","Shirts",32.99,39.99,["Burgundy","Charcoal"],A(),"Regular","Cotton",40,69,0,4.5,118),
  p("Men","Basix","Relaxed Denim Shirt","Shirts",42.99,null,["Light Wash"],A("XS"),"Relaxed","Denim",18,55,1,4.1,12,"pdp-denim-3"),
  p("Men","Stride","Slim Fit Jeans","Jeans",49.99,null,["Mid Wash","Dark Rinse","Black"],W(),"Slim","Denim",70,92,0,4.5,356),
  p("Men","Stride","Straight Fit Jeans","Jeans",49.99,59.99,["Light Wash","Mid Wash"],W("28"),"Regular","Denim",52,84,0,4.4,241),
  p("Men","Basix","Relaxed Fit Jeans","Jeans",44.99,null,["Dark Rinse"],W("28","38"),"Relaxed","Denim",4,50,0,4.2,67),
  p("Men","Northfold","Stretch Chinos","Pants & shorts",39.99,null,["Khaki","Navy","Olive"],W(),"Slim","Cotton",64,79,0,4.6,203),
  p("Men","Coastline","Cargo Shorts","Pants & shorts",27.99,null,["Khaki","Olive"],W("38"),"Relaxed","Cotton",33,48,0,4.1,58),
  p("Men","FitCore","Jogger Pants","Pants & shorts",34.99,null,["Black","Charcoal"],A(),"Regular","Polyester",55,74,0,4.4,139),
  p("Men","Basix","Pullover Hoodie","Sweaters & hoodies",34.99,null,["Heather Gray","Black","Navy"],A(),"Regular","Cotton",90,95,0,4.7,388),
  p("Men","Northfold","Merino Crewneck Sweater","Sweaters & hoodies",59.99,null,["Camel","Navy","Charcoal"],A("XS"),"Regular","Wool blend",22,60,1,4.5,44),
  p("Men","Basix","Quarter-Zip Sweatshirt","Sweaters & hoodies",36.99,44.99,["Heather Gray","Olive"],A(),"Regular","Cotton",41,66,0,4.3,87),
  p("Men","Basix","Vintage Denim Jacket","Jackets & coats",69.99,null,["Light Wash","Mid Wash","Dark Rinse"],A("XS"),"Regular","Denim",48,83,1,4.3,18,"pdp-denim-1","product.html"),
  p("Men","Coastline","Quilted Puffer Jacket","Jackets & coats",89.99,119.99,["Black","Olive"],A("XS"),"Regular","Polyester",27,71,0,4.6,129),
  p("Men","Northfold","Wool-Blend Overcoat","Jackets & coats",149.99,null,["Camel","Charcoal"],A("XS","XXL"),"Slim","Wool blend",12,45,1,4.4,22),
  p("Men","FitCore","Packable Rain Jacket","Jackets & coats",64.99,null,["Navy","Rust"],[],"Regular","Polyester",0,52,0,4.2,63),
  p("Men","FitCore","Training Tee","Activewear",19.99,null,["Black","Navy","Heather Gray"],A(),"Slim","Polyester",85,76,0,4.5,164),
  p("Men","FitCore","Running Shorts, 7 in","Activewear",24.99,null,["Black","Charcoal"],A("XXL"),"Regular","Polyester",46,63,0,4.3,91),
  p("Men","FitCore","Tech Fleece Zip Jacket","Activewear",54.99,69.99,["Charcoal","Black"],A(),"Slim","Polyester",3,70,0,4.6,77),
  p("Women","Basix","Everyday V-Neck Tee","Tops",12.99,null,["White","Black","Blush","Sage"],A(),"Regular","Cotton",110,96,0,4.6,502),
  p("Women","Northfold","Button-Front Blouse","Tops",34.99,null,["Cream","Navy"],A("XXL"),"Relaxed","Polyester",28,62,0,4.3,85),
  p("Women","Coastline","Ribbed Tank Top","Tops",14.99,null,["Black","White","Rust"],A(),"Slim","Cotton",75,81,0,4.5,219),
  p("Women","Coastline","Linen Midi Dress","Dresses",49.99,null,["Sage","Cream"],A("XXL"),"Relaxed","Linen",20,67,1,4.4,38),
  p("Women","Northfold","Wrap Dress","Dresses",54.99,69.99,["Navy","Burgundy"],A(),"Regular","Polyester",31,73,0,4.5,112),
  p("Women","Basix","T-Shirt Dress","Dresses",24.99,null,["Black","Heather Gray"],A(),"Relaxed","Cotton",58,78,0,4.4,176),
  p("Women","Stride","High-Rise Skinny Jeans","Bottoms",44.99,null,["Mid Wash","Black"],N(),"Slim","Denim",66,90,0,4.5,331),
  p("Women","Stride","Wide-Leg Jeans","Bottoms",49.99,null,["Light Wash"],N("0","16"),"Relaxed","Denim",35,70,1,4.3,41),
  p("Women","Northfold","Pleated Midi Skirt","Bottoms",39.99,null,["Camel","Black"],A("XXL"),"Regular","Polyester",24,54,0,4.2,49),
  p("Women","Basix","Cropped Cardigan","Sweaters & hoodies",32.99,null,["Cream","Blush"],A(),"Regular","Cotton",37,65,1,4.4,52),
  p("Women","Basix","Oversized Hoodie","Sweaters & hoodies",34.99,42.99,["Sage","Heather Gray"],A(),"Relaxed","Cotton",49,82,0,4.6,207),
  p("Women","Coastline","Classic Denim Jacket","Jackets & coats",64.99,null,["Light Wash"],A("XXL"),"Regular","Denim",26,68,0,4.5,94,"pdp-denim-2"),
  p("Women","Northfold","Belted Trench Coat","Jackets & coats",119.99,null,["Camel"],A("XS"),"Regular","Polyester",14,57,1,4.6,33),
  p("Women","FitCore","High-Waist Leggings","Activewear",29.99,null,["Black","Navy","Burgundy"],A(),"Slim","Polyester",95,97,0,4.7,611),
  p("Women","FitCore","Everyday Sports Bra","Activewear",24.99,null,["Black","Blush"],A("XXL"),"Slim","Polyester",5,75,0,4.4,143),
  p("Women","Basix","Waffle Pajama Set","Sleep & lounge",39.99,null,["Blush","Heather Gray"],[],"Relaxed","Cotton",0,59,0,4.5,72),
  // Electronics
  q(E,"Audio & smart tech","SoundCo","Wireless Headphones Pro","Headphones & earbuds",149.99,199.99,3,96,0,4.6,128,{conn:"Bluetooth"},["Cocoa","Red"],"headphones"),
  q(E,"Audio & smart tech","SoundCo","Wireless Earbuds Pro","Headphones & earbuds",79.99,null,28,90,1,4.4,33,{conn:"Bluetooth"},["White"],"earbuds"),
  q(E,"Audio & smart tech","Beatline","Sport Earbuds","Headphones & earbuds",49.99,59.99,40,74,0,4.3,210,{conn:"Bluetooth"},["Black","Navy"]),
  q(E,"Audio & smart tech","SoundCo","Portable Bluetooth Speaker","Speakers",59.99,null,35,82,0,4.5,164,{conn:"Bluetooth"},["Black","Sage"]),
  q(E,"Audio & smart tech","Beatline","Smart Speaker Mini","Speakers",39.99,49.99,50,70,0,4.2,98,{conn:"Wi-Fi"},["Charcoal","White"]),
  q(E,"Audio & smart tech","SmartLink","Smart Home Hub","Smart home",99.99,129.99,2,66,1,4.0,12,{conn:"Wi-Fi"},["Charcoal"],"smart-hub"),
  q(E,"Audio & smart tech","SmartLink","Smart Plug, 2-Pack","Smart home",24.99,null,80,78,0,4.6,402,{conn:"Wi-Fi"},["White"]),
  q(E,"Audio & smart tech","Pulse","Fitness Tracker Watch","Wearables",69.99,null,22,72,1,4.3,57,{conn:"Bluetooth"},["Black","Blush"]),
  q(E,"Computer & phone","Novatech","Fast Wireless Charger","Phone cases & chargers",29.99,null,60,69,0,4.4,145,{conn:"USB-C"},["White","Black"]),
  q(E,"Computer & phone","Novatech","Slim Phone Case","Phone cases & chargers",14.99,19.99,95,81,0,4.2,380,{},["Black","Sky","Sage"]),
  q(E,"Computer & phone","KeyLab","Wireless Keyboard","Keyboards & mice",39.99,69.99,25,76,0,4.2,97,{conn:"Bluetooth"},["White"],"keyboard"),
  q(E,"Computer & phone","KeyLab","Gaming Mouse RGB","Keyboards & mice",29.99,59.99,40,85,0,4.5,410,{conn:"Wired"},["Black"],"mouse"),
  q(E,"Computer & phone","Novatech","USB-C Hub 7-in-1","Cables & hubs",24.99,49.99,4,79,0,4.4,153,{conn:"USB-C"},["Silver"],"usb-hub"),
  q(E,"Computer & phone","ErgoWorks","Aluminum Laptop Stand","Laptop accessories",39.99,null,45,68,1,4.8,21,{},["Silver"],"laptop-stand"),
  // Home & Kitchen
  q(H,"Kitchen","HomeCraft","Stainless Steel Cookware Set, 10-Piece","Cookware",119.99,199.99,18,88,0,4.7,188,{material:"Stainless steel"},["Silver"],"cookware"),
  q(H,"Kitchen","HomeCraft","Nonstick Frying Pan, 11 in","Cookware",29.99,null,55,80,0,4.5,264,{material:"Aluminum"},["Black"]),
  q(H,"Kitchen","BlendGo","Portable Blender, 20 oz","Small appliances",29.99,49.99,35,77,0,4.1,72,{material:"Plastic"},["Sage","White"],"blender"),
  q(H,"Kitchen","BrewMaster","Espresso Machine","Coffee & tea makers",349.99,449.99,0,64,0,4.6,59,{material:"Stainless steel"},["Black"],"coffee-maker"),
  q(H,"Kitchen","BrewMaster","Pour-Over Coffee Set","Coffee & tea makers",34.99,null,30,58,1,4.4,26,{material:"Glass"},["White"]),
  q(H,"Kitchen","HomeCraft","Chef's Knife, 8 in","Kitchen tools",39.99,null,42,71,0,4.7,133,{material:"Stainless steel"},["Black"]),
  q(H,"Kitchen","HomeCraft","Silicone Utensil Set, 6-Piece","Kitchen tools",19.99,24.99,70,74,0,4.5,219,{material:"Silicone"},["Sage","Charcoal"]),
  q(H,"Home","Lumen","Modern LED Accent Lamp","Lighting",89.99,null,15,62,0,4.3,41,{material:"Wood"},["Oak"],"lamp"),
  q(H,"Home","Lumen","Ceramic Table Lamp","Lighting",49.99,null,20,55,1,4.4,18,{material:"Ceramic"},["Cream","Sage"]),
  q(H,"Home","Nook & Co","Stackable Storage Bins, 3-Pack","Storage & organization",27.99,34.99,60,79,0,4.6,301,{material:"Fabric"},["Heather Gray","Cream"]),
  q(H,"Home","Nook & Co","Ceramic Vase Set","Home décor",34.99,null,24,52,1,4.5,22,{material:"Ceramic"},["Cream","Rust"]),
  q(H,"Home","Coastline Home","Cotton Bath Towel Set","Bedding & bath",39.99,null,48,73,0,4.6,187,{material:"Cotton"},["White","Navy","Sage"]),
  q(H,"Home","Coastline Home","Linen Duvet Cover, Queen","Bedding & bath",79.99,99.99,14,60,1,4.4,35,{material:"Linen"},["Cream","Sky"]),
  // Grocery (shelf-stable only)
  q(GR,"Pantry","Harvest Lane","Sea Salt Kettle Chips","Snacks",3.99,null,200,92,0,4.6,512,{diet:["Gluten-free","Vegan"]}),
  q(GR,"Pantry","Harvest Lane","Classic Trail Mix, 16 oz","Snacks",6.99,8.49,120,80,0,4.5,241,{diet:["Vegan","Non-GMO"]}),
  q(GR,"Pantry","Morning Mill","Organic Honey Granola","Breakfast & cereal",5.49,null,90,77,1,4.4,63,{diet:["Organic"]}),
  q(GR,"Pantry","Morning Mill","Toasted Oat Cereal","Breakfast & cereal",4.29,null,110,84,0,4.3,198,{diet:["Non-GMO"]}),
  q(GR,"Pantry","Harvest Lane","Extra Virgin Olive Oil, 500 ml","Pantry staples",11.99,13.99,70,72,0,4.7,155,{diet:["Organic","Vegan"]}),
  q(GR,"Pantry","Harvest Lane","Basmati Rice, 2 lb","Pantry staples",5.99,null,85,69,0,4.6,121,{diet:["Gluten-free","Vegan"]}),
  q(GR,"Pantry","Spice Route","Thai Red Curry Paste","International foods",3.99,null,60,58,1,4.4,40,{diet:["Vegan"]}),
  q(GR,"Drinks & treats","Bean & Leaf","Medium Roast Ground Coffee, 12 oz","Coffee & tea",9.99,11.99,140,94,0,4.6,622,{diet:["Organic"]}),
  q(GR,"Drinks & treats","Bean & Leaf","Green Tea, 20 Bags","Coffee & tea",4.49,null,100,66,0,4.5,88,{diet:["Organic","Vegan"]}),
  q(GR,"Drinks & treats","Sunpress","Sparkling Water, 12-Pack","Juices & drinks",6.99,null,0,75,0,4.3,176,{diet:["Vegan"]}),
  q(GR,"Drinks & treats","Cocoa Row","70% Dark Chocolate Bar","Candy & chocolate",3.49,null,160,79,0,4.7,301,{diet:["Vegan","Gluten-free"]}),
  q(GR,"Drinks & treats","Cocoa Row","Fruit Gummy Bears","Candy & chocolate",2.99,null,130,70,1,4.2,54,{diet:["Gluten-free"]}),
  // Beauty & Personal Care
  q(B,"Beauty","GlowLab","Luxury Skincare Set, 4-Piece","Skin care",64.00,80.00,0,80,0,4.5,64,{skin:["All skin types"]},[],"skincare"),
  q(B,"Beauty","GlowLab","Hydrating Face Serum","Skin care",24.99,null,55,86,1,4.6,142,{skin:["Dry","Sensitive"]}),
  q(B,"Beauty","GlowLab","Daily Moisturizer SPF 30","Skin care",18.99,22.99,70,82,0,4.5,233,{skin:["All skin types","Oily"]}),
  q(B,"Beauty","Tintly","Lengthening Mascara","Makeup",9.99,null,90,77,0,4.3,318,{skin:["Sensitive"]}),
  q(B,"Beauty","Tintly","Tinted Lip Balm, 3-Pack","Makeup",12.99,null,65,71,1,4.4,47,{skin:["All skin types"]}),
  q(B,"Beauty","Rootwell","Repair Shampoo","Hair care",11.99,null,75,68,0,4.4,160,{skin:["Dry"]}),
  q(B,"Beauty","Rootwell","Defining Curl Cream","Hair care",13.99,16.99,40,64,0,4.5,92,{skin:["Curly hair"]}),
  q(B,"Beauty","Aura & Co","Eau de Parfum, 50 ml","Fragrance",48.00,null,20,58,1,4.6,29,{skin:["All skin types"]}),
  q(B,"Personal care","PureBath","Shea Butter Body Wash","Bath & body",7.99,null,120,79,0,4.6,275,{skin:["Sensitive","Dry"]}),
  q(B,"Personal care","BrightSmile","Rechargeable Electric Toothbrush","Oral care",39.99,49.99,30,73,0,4.5,188,{}),
  q(B,"Personal care","Groomly","5-Blade Razor Kit","Shaving & grooming",19.99,null,50,66,0,4.3,104,{skin:["Sensitive"]}),
  // Books & Stationery (sample titles)
  q(K,"Books","Northlight Press","The Quiet Harbor: A Novel","Fiction",14.99,null,40,78,0,4.5,212,{format:"Paperback"}),
  q(K,"Books","Northlight Press","Midnight Orchard","Fiction",24.99,27.99,25,70,1,4.6,48,{format:"Hardcover"}),
  q(K,"Books","Brightpath Books","Small Habits, Big Days","Non-fiction",16.99,null,35,74,0,4.4,131,{format:"Paperback"}),
  q(K,"Books","Brightpath Books","The Weeknight Kitchen","Non-fiction",29.99,null,18,60,1,4.7,36,{format:"Hardcover"}),
  q(K,"Books","Little Lantern","Luna and the Lighthouse","Children's books",12.99,null,30,68,0,4.8,97,{format:"Hardcover"}),
  q(K,"Books","Little Lantern","Count the Stars","Children's books",7.99,null,45,64,0,4.6,58,{format:"Board book"}),
  q(K,"Stationery","Inkwell","Dotted Notebook, A5","Notebooks & journals",12.99,null,80,82,0,4.7,244,{format:"Hardcover"},["Navy","Sage","Blush"]),
  q(K,"Stationery","Inkwell","2027 Weekly Planner","Notebooks & journals",18.99,null,60,76,1,4.5,39,{format:"Spiral"},["Charcoal","Sage"]),
  q(K,"Stationery","Inkwell","Gel Pens, 10-Pack","Pens & pencils",9.99,12.99,150,88,0,4.6,366,{format:"Pack"}),
  q(K,"Stationery","Paperfolk","Watercolor Paint Set, 24 Colors","Art supplies",19.99,null,35,62,0,4.5,77,{format:"Pack"}),
  q(K,"Stationery","OfficeLine","Bamboo Desk Organizer","Office supplies",22.99,null,0,54,0,4.3,41,{format:"Pack"}),
  // Toys & Kids
  q(T,"Toys","BrickTown","City Builder Set, 500 Pieces","Building sets",39.99,49.99,30,90,0,4.7,286,{age:"6–8 years"}),
  q(T,"Toys","BrickTown","Starter Bricks Box","Building sets",29.99,null,45,76,0,4.6,154,{age:"3–5 years"}),
  q(T,"Toys","Brightmind","Wooden Shape Sorter","Learning toys",19.99,null,40,70,1,4.8,33,{age:"0–2 years"}),
  q(T,"Toys","Brightmind","STEM Coding Robot Kit","Learning toys",49.99,64.99,12,72,1,4.4,41,{age:"9–12 years"}),
  q(T,"Toys","Playhouse","Family Board Game Night","Games & puzzles",24.99,null,50,80,0,4.5,199,{age:"6–8 years"}),
  q(T,"Toys","Playhouse","1,000-Piece Landscape Puzzle","Games & puzzles",16.99,null,35,62,0,4.6,88,{age:"13+ years"}),
  q(T,"Toys","SunnyYard","Bubble Machine","Outdoor play",21.99,null,0,58,0,4.2,64,{age:"3–5 years"}),
  q(T,"Kids & baby","TinyNest","Muslin Swaddles, 3-Pack","Baby essentials",24.99,null,60,78,0,4.8,245,{age:"0–2 years"}),
  q(T,"Kids & baby","TinyNest","Star Night Light Projector","Kids' room",29.99,34.99,28,66,0,4.4,71,{age:"3–5 years"}),
  q(T,"Kids & baby","PackPal","Kids' School Backpack","School & backpacks",34.99,null,40,70,1,4.5,52,{age:"6–8 years"}),
  // Sports & Fitness
  q(S_,"Fitness","FitCore","Premium Yoga Mat, 6 mm","Yoga & pilates",34.99,44.99,30,92,0,4.8,305,{activity:"Yoga"},["Sage","Navy"],"yoga-mat"),
  q(S_,"Fitness","FitCore","Yoga Blocks, 2-Pack","Yoga & pilates",14.99,null,60,70,0,4.6,112,{activity:"Yoga"},["Sage","Charcoal"]),
  q(S_,"Fitness","FitCore","Adjustable Dumbbells, 25 lb","Weights & training",129.99,159.99,8,74,0,4.6,86,{activity:"Strength"},["Black"]),
  q(S_,"Fitness","FitCore","Resistance Bands Set","Weights & training",19.99,null,90,84,0,4.5,277,{activity:"Strength"},["Black"]),
  q(S_,"Fitness","FitCore","Speed Jump Rope","Fitness accessories",12.99,null,70,66,1,4.3,39,{activity:"Cardio"},["Black","Teal"]),
  q(S_,"Outdoors","TrailPeak","2-Person Dome Tent","Camping & hiking",89.99,119.99,15,64,0,4.5,73,{activity:"Camping & hiking"},["Olive"]),
  q(S_,"Outdoors","TrailPeak","Hiking Daypack, 20 L","Camping & hiking",44.99,null,32,68,1,4.6,44,{activity:"Camping & hiking"},["Rust","Charcoal"]),
  q(S_,"Outdoors","RideOn","Commuter Bike Helmet","Cycling",39.99,null,25,60,0,4.4,58,{activity:"Cycling"},["Black","White"]),
  q(S_,"Outdoors","RideOn","Rechargeable Bike Light Set","Cycling",19.99,24.99,0,57,1,4.3,31,{activity:"Cycling"},["Black"]),
  q(S_,"Outdoors","HydraFlow","Insulated Water Bottle, 24 oz","Water bottles",24.99,null,110,88,0,4.7,420,{activity:"Everyday"},["Teal","Black","Blush"]),
  // Lifestyle
  q(L,"Gifts","Giftwell","Relaxing Spa Gift Set","Gift sets",34.99,44.99,30,76,0,4.6,96,{occasion:["Birthday","Holiday"]}),
  q(L,"Gifts","Giftwell","Gourmet Snack Gift Box","Gift sets",39.99,null,25,70,1,4.5,34,{occasion:["Holiday"]}),
  q(L,"Gifts","Hearth","Fall Candle Trio","Seasonal",29.99,null,40,72,1,4.7,28,{occasion:["Holiday"]}),
  q(L,"Gifts","Hearth","Holiday Ornament Set, 12-Piece","Seasonal",19.99,24.99,50,60,0,4.4,61,{occasion:["Holiday"]}),
  q(L,"Gifts","Confetti Co","Birthday Party Kit","Party supplies",24.99,null,0,58,0,4.3,47,{occasion:["Birthday"]}),
  q(L,"Everyday","Wayfarer","Canvas Weekender Bag","Bags & travel",59.99,79.99,18,68,0,4.6,83,{occasion:["Travel"]},["Olive","Navy"]),
  q(L,"Everyday","Wayfarer","Packing Cubes, 4-Pack","Bags & travel",24.99,null,55,74,0,4.7,190,{occasion:["Travel"]},["Charcoal","Sage"]),
  q(L,"Everyday","PawPal","Dog Chew Toy Set","Pet supplies",14.99,null,70,77,0,4.4,152,{occasion:["Everyday"]}),
  q(L,"Everyday","PawPal","Cat Scratcher Lounge","Pet supplies",19.99,null,35,63,1,4.5,40,{occasion:["Everyday"]}),
  q(L,"Everyday","Hearth","Vanilla Soy Candle, 8 oz","Candles & home fragrance",16.99,null,65,79,0,4.6,211,{occasion:["Everyday","Birthday"]})
];
